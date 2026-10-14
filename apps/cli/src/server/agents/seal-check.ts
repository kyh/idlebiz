import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { LoadReport } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";
import { RUNNER_IDS } from "@repo/domain/runners";
import { machineSeal } from "./machine-seal";
import { SANDBOX_EXEC, sealedCommand } from "./seal";
import type { Seal } from "./seal";

/** How a program run under the profile ended: its exit code, or null when it never ran or was killed. */
export type SealProbe = (
  argv: readonly string[],
  env: Record<string, string>,
) => Promise<number | null>;

const PROBE_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

const Exited = z.object({ code: z.number() });

const runProbe: SealProbe = async ([bin = SANDBOX_EXEC, ...args], env) => {
  try {
    await execFileAsync(bin, args, { env, timeout: PROBE_TIMEOUT_MS });
    return 0;
  } catch (error) {
    const exited = Exited.safeParse(error);
    return exited.success ? exited.data.code : null;
  }
};

// Exit 0 only when the sealed canary cannot be read (3 when it can) and a new file beside it,
// where no rule allows a write, cannot be made (5 when it can).
const CANARIES = `const fs = require("node:fs");
const [canary, fresh] = process.argv.slice(1);
try { fs.readFileSync(canary); process.exit(3); } catch (error) { if (error.code !== "EPERM") process.exit(4); }
try { fs.writeFileSync(fresh, "x", { flag: "wx" }); process.exit(5); } catch (error) { process.exit(error.code === "EPERM" ? 0 : 6); }`;

const refusalFor = (code: number | null): string | null => {
  if (code === 0) {
    return null;
  }
  if (code === null) {
    return "IdleBiz could not run macOS's sandbox-exec, which every employee run starts inside, so none will start.";
  }
  if (code === 3) {
    return "IdleBiz's sandbox let a run read a file it seals, so no employee run will start.";
  }
  if (code === 5) {
    return "IdleBiz's sandbox let a run write outside its own folders, so no employee run will start.";
  }
  return `An employee run could not start inside IdleBiz's sandbox (exit ${code}), so none will.`;
};

/**
 * Why no run can be sealed, or null when every runner's can: under each one's profile, a canary
 * sealed the way secrets.json is must be unreadable, a file where no rule allows a write must
 * not be made, and the runtime the ACP adapters run on must start. The canaries sit in TMPDIR,
 * so the probe's profile leaves out the scratch folders every run writes. Free: nothing here
 * asks a model.
 */
export const checkSeal = async (
  seal: Seal,
  probe: SealProbe = runProbe,
): Promise<string | null> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "idlebiz-seal-")));
  try {
    const canary = path.join(dir, "secrets.json");
    await writeFile(canary, "canary");
    const probed: Seal = {
      ...seal,
      scratch: [],
      unreadable: [...seal.unreadable, { match: "subpath", path: canary }],
    };
    const codes = await Promise.all(
      RUNNER_IDS.map((runner) =>
        probe(
          sealedCommand(probed, runner, [
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
    return codes.map(refusalFor).find((refusal) => refusal !== null) ?? null;
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

/** Whether employee runs start sealed; a refusal is the sentence the founder reads. */
export type SealState = { kind: "sealed" } | { kind: "refused"; reason: string };

/** Whether this machine can seal runs at all, checked before any run starts. */
export const sealRuns = async (): Promise<SealState> => {
  try {
    const refusal = await checkSeal(await machineSeal([]));
    return refusal === null ? { kind: "sealed" } : { kind: "refused", reason: refusal };
  } catch (error) {
    const reason = `IdleBiz could not check the sandbox employee runs start inside (${errorMessage(error)}), so none will start.`;
    return { kind: "refused", reason };
  }
};

/** Boot's report with the seal's refusal beside what it left out of the save: every run, for want of the sandbox. */
export const notingSeal = (report: LoadReport, refusal: string | null): LoadReport =>
  refusal === null
    ? report
    : {
        ...report,
        skipped: [
          ...report.skipped,
          { error: refusal, kind: "seal", newerBuild: false, path: SANDBOX_EXEC },
        ],
      };
