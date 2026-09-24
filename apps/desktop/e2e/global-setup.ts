import { readlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

// Every unpackaged launch takes the dev app's userData and so its single-instance lock: with
// `pnpm dev:desktop` up, each launch would only raise that window and quit.
const LOCK = path.join(
  homedir(),
  "Library",
  "Application Support",
  "IdleBiz (dev)",
  "SingletonLock",
);

/** The pid holding the dev lock on this machine, or null when nothing does (Chromium's lock names `<host>-<pid>`). */
const lockHolder = (): number | null => {
  let target: string;
  try {
    target = readlinkSync(LOCK);
  } catch {
    return null;
  }
  const at = target.lastIndexOf("-");
  const pid = Number(target.slice(at + 1));
  if (target.slice(0, at) !== hostname() || !Number.isInteger(pid)) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
};

const refuseWhileDevRuns = (): void => {
  const pid = lockHolder();
  if (pid !== null) {
    throw new Error(
      `IdleBiz (dev) is running (pid ${pid}) and holds the lock every e2e launch needs — quit it first (pnpm dev:kill).`,
    );
  }
};

export default refuseWhileDevRuns;
