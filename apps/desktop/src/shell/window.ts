import { BrowserWindow, app, shell } from "electron";
import { handoffSchema } from "idlebiz/host";
import { classify, createExternalOpens, isWebUrl, pageOrigin } from "./navigation";
import { heldMain, isQuitting, tellMain } from "./shell";
import { shellLog } from "./shell-log";

const HANDOFF_TIMEOUT_MS = 10_000;

let window: BrowserWindow | null = null;
let making: Promise<BrowserWindow> | null = null;

const told = (state: "blurred" | "minimized" | "hidden" | "shown") => {
  tellMain("window", { state });
};

const handoff = async () => {
  const main = heldMain();

  if (main === null) {
    throw new Error("IdleBiz is still starting.");
  }

  const { handoffUrl, origin } = await main.request(
    "handoff",
    null,
    handoffSchema,
    HANDOFF_TIMEOUT_MS,
  );

  if (pageOrigin(handoffUrl) !== origin) {
    throw new Error(`main's page must be on loopback, at the origin it names, not ${origin}`);
  }

  return { origin, url: handoffUrl };
};

const siteOf = (url: string) => (URL.canParse(url) ? new URL(url).origin : "a page");

const pin = (made: BrowserWindow, pinned: string) => {
  const opens = createExternalOpens();
  const contents = made.webContents;

  const openExternally = (url: string) => {
    const site = siteOf(url);

    if (!opens.allow(Date.now())) {
      shellLog(`refused to open a page on ${site}: another opened less than a second ago`);

      return;
    }

    void (async () => {
      try {
        await shell.openExternal(url);
      } catch (error) {
        shellLog(`could not open a page on ${site} in the browser: ${String(error)}`);
      }
    })();
  };

  const guard = (event: Electron.Event<{ url: string }>) => {
    const verdict = classify(event.url, pinned);

    if (verdict === "allow") {
      return;
    }

    event.preventDefault();

    if (verdict === "open-externally") {
      openExternally(event.url);
    }
  };

  contents.on("will-frame-navigate", guard);
  contents.on("will-redirect", guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      openExternally(url);
    }

    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  contents.session.setPermissionRequestHandler((_contents, _permission, answer) => {
    answer(false);
  });
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on("will-download", (event) => {
    event.preventDefault();
  });
};

const watch = (made: BrowserWindow) => {
  made.on("close", (event) => {
    if (isQuitting()) {
      return;
    }

    event.preventDefault();
    made.hide();
    app.dock?.hide();
    told("hidden");
  });
  made.on("blur", () => {
    told("blurred");
  });
  made.on("minimize", () => {
    told("minimized");
  });
  made.on("closed", () => {
    window = null;
  });
};

const make = async () => {
  const { origin, url } = await handoff();

  const made = new BrowserWindow({
    backgroundColor: "#12141c",
    height: 800,
    show: false,
    title: "IdleBiz",
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
    width: 1280,
  });

  pin(made, origin);
  watch(made);
  made.on("page-title-updated", (event) => {
    event.preventDefault();
  });
  made.webContents.once("did-finish-load", () => {
    shellLog("window loaded");
    made.show();
    made.focus();
    told("shown");
  });
  window = made;
  await made.loadURL(url);

  return made;
};

/**
 * The one window, over main's own page and pinned to its origin, made if it is not there yet. The
 * link it opens on is asked of main for each window made, since a link left unused for five minutes
 * signs nothing in. The first load shows it, and only the first: a reload must not bring back a
 * window Close hid.
 */
export const createWindow = async () => {
  if (window !== null) {
    return window;
  }

  making ??= make().finally(() => {
    making = null;
  });

  return await making;
};

/** Brings the office back: the window as it was, made now if a launch at login never made it. */
export const showWindow = () => {
  void (async () => {
    try {
      await app.dock?.show();
    } catch (error) {
      shellLog(`could not show the dock icon: ${String(error)}`);
    }

    if (window === null) {
      try {
        await createWindow();
      } catch (error) {
        shellLog(`could not make the window: ${String(error)}`);
      }

      return;
    }

    if (window.isMinimized()) {
      window.restore();
    }

    window.show();
    window.focus();
    told("shown");
  })();
};
