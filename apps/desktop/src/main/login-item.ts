import { host, launch } from "@/main/host";
import type { LaunchAtLogin } from "@/shared/domain";
import { RefusalError } from "@/shared/refusal";

// The OS login item is the only record: nothing in the save says whether IdleBiz opens at login.
// The shell registers the app itself with macOS (SMAppService), so a dev build, which is no
// installed IdleBiz, has none to register.

export const launchAtLogin = async (): Promise<LaunchAtLogin> =>
  launch().packaged ? await host().loginItem(null) : "unavailable";

/** macOS may refuse without a word, so what it answers is read back rather than assumed. */
export const setLaunchAtLogin = async (on: boolean): Promise<LaunchAtLogin> => {
  if (!launch().packaged) {
    throw new RefusalError("Only the installed app can open at login, not a dev build.");
  }
  return await host().loginItem(on);
};

/** A launch at login starts in the menu bar: the founder did not ask to see the office. */
export const openedAtLogin = (): boolean => launch().packaged && launch().openedAtLogin;
