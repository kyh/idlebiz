// Every message of the relay either way is named in RELAY_METHODS and shaped by a schema here. The
// shell's end (src-tauri/src/protocol.rs) compiles against none of it, so both ends are pinned to
// one sample of each method (src-tauri/tests/fixtures/relay): `host.test.ts` parses each with its
// schema here, and `cargo test` reads each into the shell's types.

import { z } from "zod";
import type { Peer } from "./relay/rpc";
import { sealingKeySchema } from "./secrets";
import { LAUNCH_AT_LOGIN } from "@repo/domain/domain";
import type { LaunchAtLogin } from "@repo/domain/domain";

export const RELAY_METHODS = [
  "hello",
  "handoff",
  "quit",
  "window",
  "tray",
  "host.messageBox",
  "host.copyText",
  "host.open",
  "host.loginItem",
  "host.notify",
  "host.tray",
  "host.keepAwake",
  "host.relaunch",
] as const;
export type RelayMethod = (typeof RELAY_METHODS)[number];

export const launchSchema = z.strictObject({
  // a launch at login starts in the menu bar
  openedAtLogin: z.boolean(),
  packaged: z.boolean(),
  // Vite's dev server, whose files main hands the page in place of the built ones, so it reloads in
  // place: `tauri dev`'s and `pnpm dev:browser`'s. Null in a packaged app, which serves what it ships
  pageDevUrl: z.string().nullable(),
  // the key the Keychain keeps for sealing secrets.json; null in dev, which seals with its own, or
  // when the Keychain would not answer
  sealingKey: sealingKeySchema.nullable(),
});
export type Launch = z.infer<typeof launchSchema>;
/** The hello as the shell writes it. */
export type LaunchHello = z.input<typeof launchSchema>;

/** What main answers the shell's `handoff`: a link into its page, and the origin it is on. */
export const handoffSchema = z.strictObject({ handoffUrl: z.string(), origin: z.string() });
export type Handoff = z.infer<typeof handoffSchema>;

// what the shell says of its one window: blurred, minimized, hidden (closing it hides it: the
// office lives on in the menu bar, and the dock goes with it), or shown again
export const windowSchema = z.strictObject({
  state: z.enum(["blurred", "minimized", "hidden", "shown"]),
});
export type WindowChange = z.infer<typeof windowSchema>;

/** A click on the menu-bar icon's autopilot item, with the state its label promised. */
export const trayClickSchema = z.strictObject({ on: z.boolean() });

export const messageBoxSchema = z.strictObject({
  detail: z.string().nullable(),
  kind: z.enum(["info", "warning", "error"]),
  message: z.string(),
});
type MessageBox = z.infer<typeof messageBoxSchema>;

export const copyTextSchema = z.strictObject({ text: z.string() });
type CopyText = z.infer<typeof copyTextSchema>;

/** What main asks the system to open: a URL in the browser, a file or folder in Finder. */
export const openingSchema = z.strictObject({
  kind: z.enum(["path", "reveal", "url"]),
  target: z.string(),
});
type Opening = z.infer<typeof openingSchema>;

// reads the login item, or sets it first
export const loginItemSchema = z.strictObject({ on: z.boolean().nullable() });
type LoginItem = z.infer<typeof loginItemSchema>;

export const launchAtLoginSchema = z.enum(LAUNCH_AT_LOGIN);

export const noteSchema = z.strictObject({ body: z.string(), title: z.string() });
type Note = z.infer<typeof noteSchema>;

const trayItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open"), label: z.string() }),
  z.strictObject({ kind: z.literal("status"), label: z.string() }),
  // `on` is what a click sets: what the label said when the menu was drawn
  z.strictObject({
    enabled: z.boolean(),
    kind: z.literal("autopilot"),
    label: z.string(),
    on: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("separator") }),
  z.strictObject({ kind: z.literal("quit"), label: z.string() }),
]);
export type TrayItem = z.infer<typeof trayItemSchema>;

// the menu-bar icon as main sees it: its title beside the icon, its tooltip and its menu
export const trayModelSchema = z.strictObject({
  items: z.array(trayItemSchema),
  title: z.string(),
  tooltip: z.string(),
});
type TrayModel = z.infer<typeof trayModelSchema>;

export const keepAwakeSchema = z.strictObject({ on: z.boolean() });
type KeepAwake = z.infer<typeof keepAwakeSchema>;

export interface Host {
  messageBox: (box: MessageBox) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  open: (opening: Opening) => Promise<void>;
  notify: (note: Note) => void;
  // what macOS answers is read back, never assumed
  loginItem: (on: boolean | null) => Promise<LaunchAtLogin>;
  tray: (model: TrayModel) => void;
  keepAwake: (on: boolean) => void;
  // ends main and starts the app again: what a reset does once the save is gone
  relaunch: () => void;
}

export const hostOver = (peer: Peer<RelayMethod>): Host => ({
  copyText: async (text) => {
    await peer.request("host.copyText", { text } satisfies CopyText, z.null());
  },
  keepAwake: (on) => {
    peer.notify("host.keepAwake", { on } satisfies KeepAwake);
  },
  loginItem: async (on) =>
    await peer.request("host.loginItem", { on } satisfies LoginItem, launchAtLoginSchema),
  messageBox: async (box) => {
    await peer.request("host.messageBox", box, z.null());
  },
  notify: (note) => {
    peer.notify("host.notify", note);
  },
  open: async (opening) => {
    await peer.request("host.open", opening, z.null());
  },
  relaunch: () => {
    peer.notify("host.relaunch", null);
  },
  tray: (model) => {
    peer.notify("host.tray", model);
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
