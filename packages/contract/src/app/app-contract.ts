// What the app does for the page that a page cannot: the clipboard and the login item.

import { oc, type } from "@orpc/contract";
import type { LaunchAtLogin } from "@repo/domain/domain";
import type { Done } from "../done";
import { copyTextInput, setLaunchAtLoginInput } from "./app-schema";

export const appContract = {
  /** Copies text: the window is refused the clipboard, so the shell writes it. */
  copyText: oc.input(copyTextInput).output(type<Done>()),
  /** Whether IdleBiz opens at login, as macOS answers. */
  launchAtLogin: oc.output(type<LaunchAtLogin>()),
  /** Turns opening at login on or off, answered as macOS reads it back. */
  setLaunchAtLogin: oc.input(setLaunchAtLoginInput).output(type<LaunchAtLogin>()),
};
