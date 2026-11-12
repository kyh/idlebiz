import { runnerBin } from "@repo/agent-driver/detect";
import { DEV_PORT } from "@repo/contract/routes";
import type { LoadReport } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";
import { RUNNER_IDS } from "@repo/domain/runners";
import { checkSandbox } from "@repo/sandbox/check";
import type { SandboxCheck } from "@repo/sandbox/check";
import { watchDenials } from "@repo/sandbox/denials";
import { FolderRefusedError, machineSandbox } from "@repo/sandbox/machine";
import type { FolderRefusal } from "@repo/sandbox/machine";
import { SANDBOX_EXEC } from "@repo/sandbox/profile";
import type { Sandbox } from "@repo/sandbox/profile";
import { pagePorts } from "../page-server";
import { rootDir } from "../paths";
import { RefusalError } from "../refusal";
import { secretsPath } from "../secrets";

// Vite's dev server reads any file of the checkout to whoever asks (`/@fs`) and under
// `pnpm dev:browser` signs a browser in to main's page, and main's own page port carries the
// founder's approve button: each answers anyone on loopback as the founder.
const closedPorts = (): number[] => [DEV_PORT, ...pagePorts()];

/** What a run's denials report themselves as in the system log, before the run's own label. */
const RUN_LABEL = "idlebiz-run:";

const folderRefusal = (refusal: FolderRefusal): string =>
  refusal.kind === "linked"
    ? `IdleBiz starts no run that writes ${refusal.folder} while ${refusal.link} is a symlink, which would let it write where the link leads. Remove the link to go on.`
    : `${refusal.folder} is no folder inside the save, so IdleBiz starts no run that writes it.`;

/**
 * The sandbox of a run that writes `writable`, calls the company on `apiSocket` and reports its
 * denials as `label`, resolved as this machine stands now. A folder no run may write is refused
 * as the founder reads it.
 */
export const sandboxOf = async (
  writable: readonly string[],
  apiSocket: string | null = null,
  label: string | null = null,
): Promise<Sandbox> => {
  try {
    return await machineSandbox({
      apiSocket,
      clis: RUNNER_IDS.map(runnerBin),
      closedPorts: closedPorts(),
      hostOnly: [secretsPath()],
      label: label === null ? null : `${RUN_LABEL}${label}`,
      save: rootDir(),
      writable,
    });
  } catch (error) {
    if (error instanceof FolderRefusedError) {
      throw new RefusalError(folderRefusal(error.refusal));
    }
    throw error;
  }
};

/** Writes each denial of a labelled run to main's log, for as long as main runs. */
export const logRunDenials = (): (() => void) =>
  watchDenials(RUN_LABEL, ({ label, operation, process, target }) => {
    console.error(`[sandbox] run ${label}: ${process} denied ${operation} ${target}`);
  });

const CHECK_REFUSALS = {
  "read-unreadable":
    "IdleBiz's sandbox let a run read a file it keeps from runs, so no employee run will start.",
  unavailable:
    "IdleBiz could not run macOS's sandbox-exec, which every employee run starts inside, so none will start.",
  "wrote-outside":
    "IdleBiz's sandbox let a run write outside its own folders, so no employee run will start.",
} satisfies Record<Exclude<SandboxCheck["kind"], "holds" | "failed">, string>;

const checkRefusal = (check: Exclude<SandboxCheck, { kind: "holds" }>): string =>
  check.kind === "failed"
    ? `An employee run could not start inside IdleBiz's sandbox (exit ${check.code}), so none will.`
    : CHECK_REFUSALS[check.kind];

/** Whether employee runs start sandboxed; a refusal is the sentence the founder reads. */
export type SandboxState = { kind: "sandboxed" } | { kind: "refused"; reason: string };

/** Whether this machine can sandbox runs at all, checked before any run starts. */
export const sandboxRuns = async (): Promise<SandboxState> => {
  try {
    const check = await checkSandbox(await sandboxOf([]));
    return check.kind === "holds"
      ? { kind: "sandboxed" }
      : { kind: "refused", reason: checkRefusal(check) };
  } catch (error) {
    const reason = `IdleBiz could not check the sandbox employee runs start inside (${errorMessage(error)}), so none will start.`;
    return { kind: "refused", reason };
  }
};

/** Boot's report with the sandbox's refusal beside what it left out of the save: every run, for want of it. */
export const notingSandbox = (report: LoadReport, refusal: string | null): LoadReport =>
  refusal === null
    ? report
    : {
        ...report,
        skipped: [
          ...report.skipped,
          { error: refusal, kind: "sandbox", newerBuild: false, path: SANDBOX_EXEC },
        ],
      };
