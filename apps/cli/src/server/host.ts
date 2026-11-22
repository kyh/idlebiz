import { z } from "zod";
import type { Peer } from "./relay/rpc";
import { LAUNCH_AT_LOGIN } from "@repo/domain/domain";
import type { LaunchAtLogin } from "@repo/domain/domain";

export const RELAY_METHODS = [
  "hello",
  "handoff",
  "quit",
  "window",
  "tray",
  "update",
  "inbox",
  "host.messageBox",
  "host.copyText",
  "host.open",
  "host.loginItem",
  "host.notify",
  "host.tray",
  "host.keepAwake",
  "host.relaunch",
  "host.checkUpdate",
  "host.installUpdate",
  "host.vaultSet",
  "host.vaultDelete",
] as const;

export type RelayMethod = (typeof RELAY_METHODS)[number];

export const launchSchema = z.strictObject({
  openedAtLogin: z.boolean(),
  packaged: z.boolean(),
  pageDevUrl: z.string().nullable(),
  vault: z
    .strictObject({ keys: z.record(z.string(), z.string()), refused: z.array(z.string()) })
    .nullable(),
});

export type Launch = z.infer<typeof launchSchema>;

/** The hello as the shell writes it. */
export type LaunchHello = z.input<typeof launchSchema>;

/** What main answers the shell's `handoff`: a link into its page, and the origin it is on. */
export const handoffSchema = z.strictObject({ handoffUrl: z.string(), origin: z.string() });

export type Handoff = z.infer<typeof handoffSchema>;

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

export const loginItemSchema = z.strictObject({ on: z.boolean().nullable() });

type LoginItem = z.infer<typeof loginItemSchema>;

export const launchAtLoginSchema = z.enum(LAUNCH_AT_LOGIN);

export const noteSchema = z.strictObject({ body: z.string(), title: z.string() });

type Note = z.infer<typeof noteSchema>;

const trayItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open"), label: z.string() }),
  z.strictObject({ kind: z.literal("status"), label: z.string() }),
  z.strictObject({
    enabled: z.boolean(),
    kind: z.literal("autopilot"),
    label: z.string(),
    on: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("separator") }),
  z.strictObject({ kind: z.literal("ask"), label: z.string() }),
  z.strictObject({ kind: z.literal("update"), label: z.string() }),
  z.strictObject({ kind: z.literal("quit"), label: z.string() }),
]);

export type TrayItem = z.infer<typeof trayItemSchema>;

export const trayModelSchema = z.strictObject({
  items: z.array(trayItemSchema),
  title: z.string(),
  tooltip: z.string(),
});

type TrayModel = z.infer<typeof trayModelSchema>;

export const keepAwakeSchema = z.strictObject({ on: z.boolean() });

type KeepAwake = z.infer<typeof keepAwakeSchema>;

export const releaseSchema = z.strictObject({ version: z.string() });

type Release = z.infer<typeof releaseSchema>;

export const vaultSetSchema = z.strictObject({ name: z.string(), value: z.string() });

type VaultSet = z.infer<typeof vaultSetSchema>;

export const vaultDeleteSchema = z.strictObject({ name: z.string() });

type VaultDelete = z.infer<typeof vaultDeleteSchema>;

export const installUpdateSchema = z.strictObject({ version: z.string() });

type InstallUpdate = z.infer<typeof installUpdateSchema>;

export interface Host {
  messageBox: (box: MessageBox) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  open: (opening: Opening) => Promise<void>;
  notify: (note: Note) => void;
  loginItem: (on: boolean | null) => Promise<LaunchAtLogin>;
  tray: (model: TrayModel) => void;
  keepAwake: (on: boolean) => void;
  relaunch: () => void;
  checkUpdate: () => Promise<Release | null>;
  installUpdate: (version: string) => Promise<void>;
  vaultSet: (name: string, value: string) => Promise<void>;
  vaultDelete: (name: string) => Promise<void>;
}

export const hostOver = (peer: Peer<RelayMethod>) =>
  ({
    checkUpdate: async () => await peer.request("host.checkUpdate", null, releaseSchema.nullable()),
    copyText: async (text) => {
      await peer.request("host.copyText", { text } satisfies CopyText, z.null());
    },
    installUpdate: async (version) => {
      await peer.request("host.installUpdate", { version } satisfies InstallUpdate, z.null());
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
    vaultDelete: async (name) => {
      await peer.request("host.vaultDelete", { name } satisfies VaultDelete, z.null());
    },
    vaultSet: async (name, value) => {
      await peer.request("host.vaultSet", { name, value } satisfies VaultSet, z.null());
    },
  }) satisfies Host;

let current: { host: Host; launch: Launch } | null = null;

export const setHost = (host: Host, launch: Launch) => {
  current = { host, launch };
};

const required = () => {
  if (current === null) {
    throw new Error("main has no host yet: it asked before the shell said hello");
  }

  return current;
};

export const host = () => required().host;

export const launch = () => required().launch;
