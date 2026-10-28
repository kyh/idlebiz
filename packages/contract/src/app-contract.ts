// What the app does for the page that a page cannot: the clipboard, the login item and its updates.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type { LaunchAtLogin, UpdateStatus } from "@repo/domain/domain";
import type { Done } from "./done";

export const appContract = {
  /** Copies text: the window is refused the clipboard, so the shell writes it. */
  copyText: oc.input(z.object({ text: z.string().max(20_000) })).output(type<Done>()),
  /** Installs the release on offer: the office stops its runs and the app starts again on it. */
  installUpdate: oc.output(type<Done>()),
  /** Whether IdleBiz opens at login, as macOS answers. */
  launchAtLogin: oc.output(type<LaunchAtLogin>()),
  /** Turns opening at login on or off, answered as macOS reads it back. */
  setLaunchAtLogin: oc.input(z.object({ on: z.boolean() })).output(type<LaunchAtLogin>()),
  /** What main last heard of the release feed. */
  update: oc.output(type<UpdateStatus>()),
};
