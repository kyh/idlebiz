import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { RUNNER_IDS } from "@repo/domain/runners";
import { sandboxedCommand } from "./profile";
import type { Command, Sandbox } from "./profile";

/** How a program run under the profile ended: its exit code, or null when it never ran or was killed. */
export type SandboxProbe = (
  command: Command,
  env: Record<string, string>,
) => Promise<number | null>;

/**
 * What the check found: the sandbox holds, sandbox-exec could not run, a canary it keeps was read, a
 * write landed where no rule allows one, or the probe ended some other way.
 */
export type SandboxCheck =
  | { kind: "holds" }
  | { kind: "unavailable" }
  | { kind: "read-unreadable" }
  | { kind: "wrote-outside" }
  | { kind: "failed"; code: number };

const PROBE_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

const Exited = z.object({ code: z.number() });

const runProbe: SandboxProbe = async ([bin, ...args], env) => {
  try {
    await execFileAsync(bin, args, { env, timeout: PROBE_TIMEOUT_MS });
    return 0;
  } catch (error) {
    const exited = Exited.safeParse(error);
    return exited.success ? exited.data.code : null;
  }
};

// Exit 0 only when the canary cannot be read (3 when it can) and a new file beside it, where no
// rule allows a write, cannot be made (5 when it can).
const CANARIES = `const fs = require("node:fs");
const [canary, fresh] = process.argv.slice(1);
try { fs.readFileSync(canary); process.exit(3); } catch (error) { if (error.code !== "EPERM") process.exit(4); }
try { fs.writeFileSync(fresh, "x", { flag: "wx" }); process.exit(5); } catch (error) { process.exit(error.code === "EPERM" ? 0 : 6); }`;

const checkOf = (code: number | null): SandboxCheck => {
  if (code === null) {
    return { kind: "unavailable" };
  }
  if (code === 0) {
    return { kind: "holds" };
  }
  if (code === 3) {
    return { kind: "read-unreadable" };
  }
  return code === 5 ? { kind: "wrote-outside" } : { code, kind: "failed" };
};

/**
 * Whether every runner's run can be sandboxed: under each one's profile, a canary sandboxed as the
 * host's keys are must be unreadable, a file where no rule allows a write must not be made, and the
 * runtime the ACP adapters run on must start. The canaries sit in TMPDIR, so the probe's profile
 * leaves out the scratch folders every run writes. Free: nothing here asks a model.
 */
export const checkSandbox = async (
  sandbox: Sandbox,
  probe: SandboxProbe = runProbe,
): Promise<SandboxCheck> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "sandbox-check-")));
  try {
    const canary = path.join(dir, "secrets.json");
    await writeFile(canary, "canary");
    const probed: Sandbox = {
      ...sandbox,
      scratch: [],
      unreadable: [...sandbox.unreadable, { match: "subpath", path: canary }],
    };
    const codes = await Promise.all(
      RUNNER_IDS.map((runner) =>
        probe(
          sandboxedCommand(probed, runner, [
            process.execPath,
            "-e",
            CANARIES,
            canary,
            path.join(dir, `written-by-${runner}`),
          ]),
          {},
        ),
      ),
    );
    return codes.map(checkOf).find((check) => check.kind !== "holds") ?? { kind: "holds" };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};
