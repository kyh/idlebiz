import { host, launch } from "./host";
import { guarded, report } from "./lib/report";
import { RefusalError } from "./refusal";
import type { UpdateStatus } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";

const CHECK_EVERY_MS = 6 * 60 * 60_000;

let status: UpdateStatus = { kind: "off", why: "Only the installed app updates itself." };
let announced: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let changed: (() => void) | null = null;

/** What main last heard of the release feed. */
export const updateStatus = () => status;

const moved = () => {
  if (changed !== null) {
    guarded("update status", changed);
  }
};

const heard = (version: string | null) => {
  status = version === null ? { kind: "current" } : { kind: "available", version };

  if (version !== null && version !== announced) {
    announced = version;
    host().notify({
      body: "Update from the menu bar or Settings: the office stops its runs, updates and opens again.",
      title: `IdleBiz ${version} is ready`,
    });
  }
};

const check = async () => {
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
export const startUpdateChecks = (onChange: () => void) => {
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
export const installUpdate = async () => {
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
    status = { kind: "available", version };
    await check();
    throw new RefusalError(`IdleBiz ${version} could not be downloaded: ${errorMessage(error)}`);
  }
};

const sayNotUpdated = async (reason: string) => {
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
export const installFromMenu = async () => {
  try {
    await installUpdate();
  } catch (error) {
    await sayNotUpdated(errorMessage(error));
  }
};
