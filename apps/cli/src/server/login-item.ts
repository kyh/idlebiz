import { host, launch } from "./host";
import type { LaunchAtLogin } from "@repo/domain/domain";
import { RefusalError } from "./refusal";

export const launchAtLogin = async () =>
  (launch().packaged ? await host().loginItem(null) : "unavailable") satisfies LaunchAtLogin;

/** macOS may refuse without a word, so what it answers is read back rather than assumed. */
export const setLaunchAtLogin = async (on: boolean) => {
  if (!launch().packaged) {
    throw new RefusalError("Only the installed app can open at login, not a dev build.");
  }

  return await host().loginItem(on);
};

/** A launch at login starts in the menu bar: the founder did not ask to see the office. */
export const openedAtLogin = () => launch().packaged && launch().openedAtLogin;
