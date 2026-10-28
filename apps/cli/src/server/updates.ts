import { host, launch } from "./host";
import { guarded } from "./lib/report";
import { RefusalError } from "./refusal";
import type { UpdateStatus } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";

// IdleBiz's own updates. Main asks the shell for the newest release at boot and every six hours, in
// the installed app alone, whose shell carries the updater, and offers what it finds in the menu
// bar and Settings, with one notification a version. Installing is the shell's: it downloads the
// release, stops main as Quit does, installs it and starts the app again.

const CHECK_EVERY_MS = 6 * 60 * 60_000;

let status: UpdateStatus = { kind: "off", why: "Only the installed app updates itself." };
// the newest version the founder was told of: a check every six hours tells them once
let announced: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** What main last heard of the release feed. */
export const updateStatus = (): UpdateStatus => status;

const heard = (version: string | null): void => {
  status = version === null ? { kind: "current" } : { kind: "available", version };
  if (version !== null && version !== announced) {
    announced = version;
    host().notify({
      body: "Update from the menu bar or Settings: the office stops its runs, updates and opens again.",
      title: `IdleBiz ${version} is ready`,
    });
  }
};

// never rejects: what stops a check is the status Settings shows, until the next one; an install
// under way keeps its status, since the app is about to start again on it
const check = async (changed: () => void): Promise<void> => {
  try {
    const release = await host().checkUpdate();
    if (status.kind !== "installing") {
      heard(release?.version ?? null);
    }
  } catch (error) {
    if (status.kind !== "installing") {
      status = { kind: "failed", reason: errorMessage(error) };
    }
  }
  guarded("update check", changed);
};

/** Checks now and every six hours; `changed` hears each answer, as the menu bar redraws on it. */
export const startUpdateChecks = (changed: () => void): void => {
  if (!launch().packaged || timer !== null) {
    return;
  }
  status = { kind: "checking" };
  timer = setInterval(() => {
    void check(changed);
  }, CHECK_EVERY_MS);
  timer.unref();
  void check(changed);
};

/** Has the shell install the release on offer, which ends main: the app starts again on it. */
export const installUpdate = async (): Promise<void> => {
  if (status.kind !== "available") {
    throw new RefusalError("No update is waiting to install.");
  }
  const { version } = status;
  status = { kind: "installing", version };
  try {
    await host().installUpdate(version);
  } catch (error) {
    status = { kind: "available", version };
    throw new RefusalError(`IdleBiz ${version} could not be downloaded: ${errorMessage(error)}`);
  }
};
