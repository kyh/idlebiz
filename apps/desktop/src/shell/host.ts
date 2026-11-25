import { Notification, app, clipboard, dialog, shell } from "electron";
import { z } from "zod";
import type { Peer } from "idlebiz/relay";
import {
  copyTextSchema,
  installUpdateSchema,
  keepAwakeSchema,
  loginItemSchema,
  messageBoxSchema,
  noteSchema,
  openingSchema,
  trayModelSchema,
  vaultDeleteSchema,
  vaultSetSchema,
} from "idlebiz/host";
import type { RelayMethod } from "idlebiz/host";
import { keepAwake } from "./keep-awake";
import { loginItemStatus, setLoginItem } from "./login-item";
import { isWebUrl } from "./navigation";
import { shellLog } from "./shell-log";
import { drawTray } from "./tray";
import { checkUpdate, installUpdate } from "./updater";
import { vaultDelete, vaultSet } from "./vault";

const open = async ({ kind, target }: z.infer<typeof openingSchema>) => {
  if (kind === "url") {
    if (!isWebUrl(target)) {
      throw new Error("only a web page opens in the browser");
    }

    await shell.openExternal(target);

    return;
  }

  if (kind === "reveal") {
    shell.showItemInFolder(target);

    return;
  }

  const refused = await shell.openPath(target);

  if (refused !== "") {
    throw new Error(refused);
  }
};

/**
 * What main asks of the native app and what it tells it, each read with main's own schema
 * (`apps/cli/src/server/host.ts`), so the shell and main cannot disagree on a shape: a request the
 * shell cannot read is refused with the reason, a notification logged.
 */
export const listen = (peer: Peer<RelayMethod>) => {
  peer.handle("host.messageBox", messageBoxSchema, async ({ detail, kind, message }) => {
    const box: Electron.MessageBoxOptions = { message, title: "IdleBiz", type: kind };

    if (detail !== null) {
      box.detail = detail;
    }

    await dialog.showMessageBox(box);

    return null;
  });
  peer.handle("host.copyText", copyTextSchema, async ({ text }) => {
    await clipboard.writeText(text);

    return null;
  });
  peer.handle("host.open", openingSchema, async (opening) => {
    await open(opening);

    return null;
  });
  peer.handle("host.loginItem", loginItemSchema, ({ on }) =>
    on === null ? loginItemStatus() : setLoginItem(on),
  );
  peer.handle("host.checkUpdate", z.null(), async () => await checkUpdate());
  peer.handle("host.installUpdate", installUpdateSchema, async ({ version }) => {
    await installUpdate(version);

    return null;
  });
  peer.handle("host.vaultSet", vaultSetSchema, ({ name, value }) => {
    vaultSet(name, value);

    return null;
  });
  peer.handle("host.vaultDelete", vaultDeleteSchema, ({ name }) => {
    vaultDelete(name);

    return null;
  });
  peer.on("host.tray", trayModelSchema, drawTray);
  peer.on("host.keepAwake", keepAwakeSchema, ({ on }) => {
    keepAwake(on);
  });
  peer.on("host.notify", noteSchema, ({ body, title }) => {
    if (Notification.isSupported()) {
      new Notification({ body, title }).show();
    } else {
      shellLog("could not post a notification: this system shows none");
    }
  });
  peer.on("host.relaunch", z.null(), () => {
    app.relaunch();
    app.quit();
  });
};
