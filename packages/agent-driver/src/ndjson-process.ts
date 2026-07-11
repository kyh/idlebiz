import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { zeroUsage } from "./events";
import type { RunnerResult } from "./runner";

// Every resolution path funnels through the settle() helper below, guarded by
// a `settled` flag so it resolves exactly once. oxlint's static check can't
// see that guard, so the rule is disabled for this file.
/* oxlint-disable promise/no-multiple-resolved */

/** Keep only the tail of stderr — used solely for final error reporting. */
const STDERR_TAIL_MAX = 16_000;

/**
 * After a terminal result is staged we prefer a clean exit, but stream-json
 * CLIs have a known failure mode where the process lingers — after this grace
 * window the child is killed and the staged result resolves anyway.
 */
const DEFAULT_EXIT_GRACE_MS = 10_000;

/** Human-friendly duration for watchdog messages ("45m", "3s"). */
const fmtMs = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

const failure = (error: string): RunnerResult => ({
  ok: false,
  summary: "",
  usage: zeroUsage(),
  error,
});

export interface NdjsonControl {
  /**
   * Stage the terminal result: watchdogs stand down (the outcome is already
   * known), and the result resolves on process close — or after graceMs if
   * the child refuses to exit.
   */
  finish(result: RunnerResult, graceMs?: number): void;
}

export interface NdjsonProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** Written to the child's stdin, then stdin is closed (the prompt channel). */
  stdinText: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Kill + fail after this long with no output at all. 0 disables. */
  idleTimeoutMs: number;
  /** Absolute session ceiling, even while actively streaming. 0 disables. */
  maxSessionMs: number;
  /** One parsed JSON value per stdout line (adapter narrows the shape). */
  onValue(value: unknown, ctl: NdjsonControl): void;
  /** Process closed without a staged result — compute the final outcome. */
  onExit(code: number | null, stderrTail: string): RunnerResult;
}

/**
 * Spawn a headless CLI, feed it the prompt on stdin, stream its NDJSON
 * stdout to the adapter, and guarantee resolution: idle + absolute-session
 * watchdogs mean a wedged child can never hang the scheduler.
 */
export function runNdjsonProcess(opts: NdjsonProcessOptions): Promise<RunnerResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess | undefined;
    let rl: Interface | undefined;
    let staged: RunnerResult | null = null;
    let stderrTail = "";
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Resolve exactly once and release every handle. Tearing down the pipes
    // matters: a killed child's orphaned grandchild can keep stdout open and
    // the event loop alive after we already have our answer.
    const settle = (res: RunnerResult): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      if (graceTimer) clearTimeout(graceTimer);
      try {
        rl?.close();
      } catch {
        /* ignore */
      }
      try {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
      } catch {
        /* ignore */
      }
      resolvePromise(res);
    };

    const kill = (): void => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    // Watchdog: no output for idleTimeoutMs means the process is wedged (or a
    // tool is stuck) — kill and fail so a run can never block the scheduler
    // forever. Reset on every line, so it never trips during active work.
    const pokeIdle = (): void => {
      if (opts.idleTimeoutMs <= 0 || settled || staged) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        kill();
        settle(failure(`no output for ${fmtMs(opts.idleTimeoutMs)} — treating the agent as hung`));
      }, opts.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const ctl: NdjsonControl = {
      finish(result, graceMs = DEFAULT_EXIT_GRACE_MS): void {
        if (settled || staged) return;
        staged = result;
        // The outcome is known; stand down the watchdogs so a late deadline
        // can't clobber a result we already have.
        if (idleTimer) clearTimeout(idleTimer);
        if (sessionTimer) clearTimeout(sessionTimer);
        graceTimer = setTimeout(() => {
          kill();
          settle(result);
        }, graceMs);
        graceTimer.unref?.();
      },
    };

    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (err) {
      settle(
        failure(`failed to spawn ${opts.bin}: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      kill();
      settle(failure(`${opts.bin}: stdio pipes unavailable`));
      return;
    }

    // Deliver the prompt. A child that dies before reading stdin raises
    // EPIPE here — swallow it; the close handler reports the real failure.
    stdin.on("error", () => {});
    stdin.write(opts.stdinText);
    stdin.end();

    pokeIdle(); // arm before the first byte arrives

    if (opts.maxSessionMs > 0) {
      sessionTimer = setTimeout(() => {
        if (staged) return;
        kill();
        settle(failure(`exceeded the ${fmtMs(opts.maxSessionMs)} session limit — killed`));
      }, opts.maxSessionMs);
      sessionTimer.unref?.();
    }

    rl = createInterface({ input: stdout });
    rl.on("line", (line) => {
      pokeIdle(); // any output is a sign of life
      const trimmed = line.trim();
      if (!trimmed) return;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        return; // ignore non-JSON noise
      }
      try {
        opts.onValue(value, ctl);
      } catch {
        /* an adapter bug must not wedge the run — close still settles it */
      }
    });

    stderr.on("data", (d: Buffer) => {
      pokeIdle(); // stderr output is also a sign of life
      stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_MAX);
    });

    child.on("error", (err: Error) => {
      settle(failure(`${opts.bin}: ${err.message}`));
    });

    child.on("close", (code) => {
      if (staged) {
        settle(staged);
        return;
      }
      settle(opts.onExit(code, stderrTail.trim()));
    });
  });
}
