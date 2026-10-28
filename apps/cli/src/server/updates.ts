import { host, launch } from "./host";
import { guarded, report } from "./lib/report";
import { RefusalError } from "./refusal";
import type { UpdateStatus } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";

// IdleBiz's own updates. Main asks the shell for the newest release at boot and every six hours, in
// the installed app alone, whose shell carries the updater, and offers what it finds in the menu
// bar and Settings, with one notification a version. Either one installs it through here, so both
// show the one status. Installing is the shell's: it downloads the release, stops main as Quit
// does, installs it and starts the app again.

const CHECK_EVERY_MS = 6 * 60 * 60_000;

let status: UpdateStatus = { kind: "off", why: "Only the installed app updates itself." };
// the newest version the founder was told of: a check every six hours tells them once
let announced: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
// who hears the status move, as the menu bar redraws on it: nobody until the checks start
let changed: (() => void) | null = null;

/** What main last heard of the release feed. */
export const updateStatus = (): UpdateStatus => status;

const moved = (): void => {
  if (changed !== null) {
    guarded("update status", changed);
  }
};

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

// never rejects: what stops a check is the status Settings shows, until the next one. A release
// on offer stays on offer, since its download asks the feed again, and an install under way keeps
// its status, since the app is about to start again on it.
const check = async (): Promise<void> => {
  try {
    const release = await host().checkUpdate();
    if (status.kind !== "installing") {
      heard(release?.version ?? null);
    }
  } catch (error) {
    if (status.kind !== "installing" && status.kind !== "available") {
      status = { kind: "failed", reason: errorMessage(error) };
    }
  }
  moved();
};

/** Checks now and every six hours; `onChange` hears each move of the status. */
export const startUpdateChecks = (onChange: () => void): void => {
  if (!launch().packaged || timer !== null) {
    return;
  }
  changed = onChange;
  status = { kind: "checking" };
  timer = setInterval(() => {
    void check();
  }, CHECK_EVERY_MS);
  timer.unref();
  void check();
};

/** Has the shell install the release on offer, which ends main: the app starts again on it. */
export const installUpdate = async (): Promise<void> => {
  if (status.kind === "installing") {
    throw new RefusalError(`IdleBiz ${status.version} is already downloading.`);
  }
  if (status.kind !== "available") {
    throw new RefusalError("No update is waiting to install.");
  }
  const { version } = status;
  status = { kind: "installing", version };
  moved();
  try {
    await host().installUpdate(version);
  } catch (error) {
    // the feed may have moved since it offered this one: what it offers now takes its place
    status = { kind: "available", version };
    await check();
    throw new RefusalError(`IdleBiz ${version} could not be downloaded: ${errorMessage(error)}`);
  }
};

// what stops an install the menu bar began: no page asked, so a box says it
const sayNotUpdated = async (reason: string): Promise<void> => {
  try {
    await host().messageBox({
      detail: reason,
      kind: "warning",
      message: "IdleBiz couldn't update",
    });
  } catch (error) {
    report("update from the menu", error);
  }
};

/** The menu bar's update item, which installs as Settings' button does. Never rejects. */
export const installFromMenu = async (): Promise<void> => {
  try {
    await installUpdate();
  } catch (error) {
    await sayNotUpdated(errorMessage(error));
  }
};
