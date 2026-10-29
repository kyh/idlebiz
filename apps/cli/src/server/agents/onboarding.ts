import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { RUNNERS } from "@repo/agent-driver/registry";
import { isReady } from "@repo/agent-driver/detect";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import { runnerPool } from "./runner-pool";
import type { RunnerPool } from "./runner-pool";
import { foundingTeamPrompt } from "../prompts/onboarding";
import { errorMessage } from "@repo/domain/errors";
import { RUNNER_NAMES } from "@repo/domain/runners";
import { parseJson } from "@repo/domain/json";
import type { AuthFlowEvent, BusinessTypeId } from "@repo/domain/domain";
import { HireCandidateSchema } from "@repo/domain/hire";
import type { HireCandidate } from "@repo/domain/hire";

/** How long a CLI's sign-in has to be finished in the browser before main stops it. */
const SIGN_IN_DEADLINE_MS = 5 * 60_000;

/** How long a command told to stop has to let go of what it holds, before its group is killed. */
const STOP_GRACE_MS = 2000;

/**
 * The setup under way: aborting it stops the step it is on and the command that step waits on.
 * A cancel, and a retry that takes over, reach it here.
 */
let underWay: AbortController | null = null;

const CLAUDE_INSTALL_CMD = "curl -fsSL https://claude.ai/install.sh | bash";

const reportLine =
  (emit: (e: AuthFlowEvent) => void) =>
  (line: string): void => {
    const text = line.trim();
    if (!text) {
      return;
    }
    const url = /https?:\/\/\S+/u.exec(text)?.[0];
    if (url) {
      emit({ type: "url", url });
    } else {
      emit({ message: text.slice(0, 200), type: "progress" });
    }
  };

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
};

/**
 * Spawn a command, streaming its output lines as progress (URLs get their own event), until it
 * exits or `signal` aborts. It leads a process group of its own, so an abort stops what it started
 * too (a login's browser opener): the group is asked to stop, so a login can let go of its
 * callback port, then killed. Main's exit kills it outright, with no time left to ask.
 */
const streamCommand = (
  cmd: string,
  args: string[],
  emit: (e: AuthFlowEvent) => void,
  signal: AbortSignal,
): Promise<number | null> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const child = spawn(cmd, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const onLine = reportLine(emit);
    const reading = [child.stdout, child.stderr].map((input) =>
      createInterface({ input }).on("line", onLine),
    );
    const { pid } = child;
    const kill = (): void => {
      if (pid !== undefined) {
        signalGroup(pid, "SIGKILL");
      }
    };
    const stop = (): void => {
      for (const lines of reading) {
        lines.close();
      }
      if (pid !== undefined) {
        signalGroup(pid, "SIGTERM");
        setTimeout(kill, STOP_GRACE_MS).unref();
      }
      resolve(null);
    };
    signal.addEventListener("abort", stop, { once: true });
    process.once("exit", kill);
    const settle = (code: number | null): void => {
      signal.removeEventListener("abort", stop);
      process.off("exit", kill);
      resolve(code);
    };
    child.on("error", (err) => {
      emit({ message: err.message, type: "error" });
      settle(null);
    });
    child.on("close", settle);
  });

const label = (p: RunnerProbe): string => RUNNER_NAMES[p.id];

// A login codex keeps in the Keychain reads as none, to its runs and to the sign-in alike.
const CODEX_FILE_LOGIN =
  'If Codex keeps its login in your Keychain, which IdleBiz\'s sandbox closes to codex runs, first set cli_auth_credentials_store = "file" in ~/.codex/config.toml.';

type SignIn = Pick<
  RunnerPool,
  "needsSignIn" | "refresh" | "sealRefusal" | "sealedSignIn" | "signedInAgain"
>;

const signInState = (runners: SignIn, p: Extract<RunnerProbe, { installed: true }>): string => {
  if (!p.authed) {
    return " — not signed in";
  }
  return runners.needsSignIn(p) ? " — its login was refused, signing in again" : " — signed in ✓";
};

/**
 * Detects, installs and signs in the CLIs, saying how it goes in `emit`'s events. One setup runs
 * at a time: a second takes over from the first, whose command is stopped, and which says nothing
 * more, since the setup now under way speaks for both. A sign-in not finished in `deadlineMs`, or
 * a setup cancelled, is stopped and ends in an error, so the page can offer it again.
 */
export const startLogin = async (
  runners: SignIn,
  emit: (e: AuthFlowEvent) => void,
  deadlineMs = SIGN_IN_DEADLINE_MS,
): Promise<void> => {
  underWay?.abort(new Error("Another setup took over."));
  const setup = new AbortController();
  underWay = setup;
  const { signal } = setup;
  const say = (e: AuthFlowEvent): void => {
    if (underWay === setup && !signal.aborted) {
      emit(e);
    }
  };
  /** What `step` answers, unless the setup was stopped while it ran. */
  const unlessStopped = async <T>(step: Promise<T>): Promise<T> => {
    const answer = await step;
    signal.throwIfAborted();
    return answer;
  };
  try {
    let probes = await unlessStopped(runners.refresh());
    // no CLI is found without the seal, so installing one would not help
    const refusal = await unlessStopped(runners.sealRefusal());
    if (refusal !== null) {
      say({ message: refusal, type: "error" });
      return;
    }
    for (const p of probes) {
      say({
        message: p.installed
          ? `Found ${label(p)} (${p.version ?? "unknown version"})${signInState(runners, p)}`
          : `${label(p)} not installed`,
        type: "progress",
      });
    }

    if (probes.every((p) => !p.installed)) {
      say({ message: "No coding CLI found — installing Claude Code…", type: "progress" });
      // not a login shell: whatever its startup files source, a run could have written
      const code = await unlessStopped(
        streamCommand("/bin/bash", ["-c", CLAUDE_INSTALL_CMD], say, signal),
      );
      if (code !== 0) {
        say({
          message: "Install failed — install Claude Code or Codex manually, then retry.",
          type: "error",
        });
        return;
      }
      say({ message: "Claude Code installed.", type: "progress" });
      probes = await unlessStopped(runners.refresh());
    }

    for (const p of probes) {
      if (!runners.needsSignIn(p)) {
        continue;
      }
      say({ message: `Signing in to ${label(p)} — your browser will open…`, type: "progress" });
      const [cmd, ...args] = await unlessStopped(
        runners.sealedSignIn(p.id, [p.bin, ...RUNNERS[p.id].loginArgs]),
      );
      const deadline = AbortSignal.timeout(deadlineMs);
      const code = await unlessStopped(
        streamCommand(cmd, args, say, AbortSignal.any([signal, deadline])),
      );
      if (code === null && deadline.aborted) {
        throw new Error(`The sign-in to ${label(p)} timed out — sign in again.`);
      }
      if (code === 0) {
        runners.signedInAgain(p.id);
      } else {
        say({
          message: `Couldn't finish automatically. In a terminal, run: ${p.bin} ${RUNNERS[p.id].loginArgs.join(" ")} — then come back and retry.${p.id === "codex" ? ` ${CODEX_FILE_LOGIN}` : ""}`,
          type: "progress",
        });
      }
    }

    probes = await unlessStopped(runners.refresh());
    const ready = probes.filter((p) => isReady(p) && !runners.needsSignIn(p));
    if (ready.length > 0) {
      say({ message: `Workforce ready: ${ready.map(label).join(" + ")}.`, type: "progress" });
      say({ type: "done" });
    } else {
      say({
        message: "No signed-in coding CLI yet. Sign in to Claude Code or Codex, then retry.",
        type: "error",
      });
    }
  } catch (error) {
    if (underWay === setup) {
      emit({ message: errorMessage(error), type: "error" });
    }
  } finally {
    if (underWay === setup) {
      underWay = null;
    }
  }
};

/**
 * Stops the setup under way, which ends in an error saying so; with none under way, says that
 * instead, so a page still waiting on one stops waiting.
 */
export const cancelLogin = (emit: (e: AuthFlowEvent) => void): void => {
  if (underWay === null) {
    emit({ message: "No setup was under way.", type: "error" });
    return;
  }
  underWay.abort(new Error("Setup cancelled."));
};

const CandidatesSchema = z.array(HireCandidateSchema).min(3).max(8);

export const generateCandidates = async (input: {
  companyName: string;
  mission: string | null;
  businessType: BusinessTypeId;
}): Promise<HireCandidate[]> => {
  const prompt = foundingTeamPrompt(input.companyName, input.mission, input.businessType);
  const raw = await runnerPool.completeOneShot(prompt);
  const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  return CandidatesSchema.parse(parseJson(jsonText));
};
