// What main asks of the app that runs it, the desktop shell or the dev host: what only a native app
// does (a message box, the clipboard, Finder and the browser, the menu-bar icon, a notification,
// the login item, keeping the Mac awake, a relaunch), and the facts of this launch the shell
// alone knows, the page main serves its window among them. Each is a request or a notification
// over the relay; tests set a fake.

import { z } from "zod";
import type { Peer } from "@/main/relay/rpc";
import type { LaunchAtLogin } from "@/shared/domain";

export const launchSchema = z.object({
  // a launch at login starts in the menu bar
  openedAtLogin: z.boolean(),
  packaged: z.boolean(),
  // Vite's dev server, whose files main hands the page in place of the built ones, so it reloads in
  // place: `tauri dev`'s and `pnpm dev:browser`'s. Null in a packaged app, which serves what it ships
  pageDevUrl: z.string().nullable(),
  // the window's page as built, which main serves it (page-server.ts): the checkout's
  // `.output/renderer`, or the bundle's own copy
  pageDir: z.string().min(1),
  // where the app's own read-only files are: the bundle's resources, or the checkout's
  resourcesDir: z.string().min(1),
  // the Keychain's Safe Storage password, which seals secrets.json; null when it would not answer
  safeStoragePassword: z.string().nullable(),
});
export type Launch = z.infer<typeof launchSchema>;

/** What main answers the shell's `handoff`: a link into its page, and the origin it is on. */
export const handoffSchema = z.object({ handoffUrl: z.string(), origin: z.string() });

interface MessageBox {
  kind: "info" | "warning" | "error";
  message: string;
  detail: string | null;
}

interface HostOpening {
  kind: "path" | "reveal" | "url";
  target: string;
}

export type TrayItem =
  | { kind: "open"; label: string }
  | { kind: "status"; label: string }
  // `on` is what a click sets: what the label said when the menu was drawn
  | { kind: "autopilot"; label: string; enabled: boolean; on: boolean }
  | { kind: "separator" }
  | { kind: "quit"; label: string };

// the menu-bar icon as main sees it: its title beside the icon, its tooltip and its menu
interface TrayModel {
  title: string;
  tooltip: string;
  items: TrayItem[];
}

export interface Host {
  messageBox: (box: MessageBox) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  open: (opening: HostOpening) => Promise<void>;
  notify: (note: { title: string; body: string }) => void;
  // reads the login item, or sets it first; what macOS answers is read back, never assumed
  loginItem: (on: boolean | null) => Promise<LaunchAtLogin>;
  tray: (model: TrayModel) => void;
  keepAwake: (on: boolean) => void;
  // ends main and starts the app again: what a reset does once the save is gone
  relaunch: () => void;
}

const launchAtLoginSchema = z.enum(["on", "off", "requires-approval", "not-found", "unavailable"]);

export const hostOver = (peer: Peer): Host => ({
  copyText: async (text) => {
    await peer.request("host.copyText", { text }, z.null());
  },
  keepAwake: (on) => {
    peer.notify("host.keepAwake", { on });
  },
  loginItem: async (on) => await peer.request("host.loginItem", { on }, launchAtLoginSchema),
  messageBox: async (box) => {
    await peer.request("host.messageBox", { ...box }, z.null());
  },
  notify: (note) => {
    peer.notify("host.notify", note);
  },
  open: async (opening) => {
    await peer.request("host.open", { ...opening }, z.null());
  },
  relaunch: () => {
    peer.notify("host.relaunch", null);
  },
  tray: (model) => {
    peer.notify("host.tray", { ...model });
  },
});

let current: { host: Host; launch: Launch } | null = null;

export const setHost = (host: Host, launch: Launch): void => {
  current = { host, launch };
};

const required = () => {
  if (current === null) {
    throw new Error("main has no host yet: it asked before the shell said hello");
  }
  return current;
};

export const host = (): Host => required().host;

export const launch = (): Launch => required().launch;
