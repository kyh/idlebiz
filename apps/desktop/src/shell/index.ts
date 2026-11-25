import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import path from "node:path";
import { Menu, app, dialog } from "electron";
import { z } from "zod";
import { DEV_PORT } from "@repo/contract/routes";
import { parseJson } from "@repo/domain/json";
import type { LaunchHello, RelayMethod } from "idlebiz/host";
import { listen } from "./host";
import { launchedAtLogin } from "./login-item";
import { createMainLog, mainLogPath } from "./main-log";
import { MainLateError, describeExit, startMain } from "./main-process";
import {
  SERVE_ARGS,
  SERVE_ENTRY,
  accountOf,
  logsDir,
  mainEnv,
  resolveRuntime,
  rootArg,
  rootDir,
} from "./runtime";
import type { Packaged } from "./runtime";
import { heldMain, holdMain, markQuitting, takeMain } from "./shell";
import { shellLog, writeShellLogTo } from "./shell-log";
import { openVault } from "./vault";
import { createWindow, showWindow } from "./window";

const HELLO_TIMEOUT_MS = 60_000;

const packaged = app.isPackaged;
const unheard = new Set<string>();
let failedOnce = false;

const fail = async (title: string, reason: string) => {
  shellLog(`${title}: ${reason}`);

  if (failedOnce) {
    return;
  }

  failedOnce = true;
  await dialog.showMessageBox({ detail: reason, message: title, title: "IdleBiz", type: "error" });
  app.exit(1);
};

const userTempDir = () => {
  try {
    return execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf-8",
      env: {},
    }).trim();
  } catch {
    return null;
  }
};

const packagedLaunch = () => {
  if (!packaged) {
    return null;
  }

  return {
    account: accountOf(userInfo(), userTempDir()),
    root: rootArg(process.argv.slice(1)) ?? __IDLEBIZ_TEST_PACK_ROOT__,
  } satisfies Packaged;
};

const logsFolder = (launch: Packaged | null) => {
  const home = launch?.account.home ?? app.getPath("home");
  const override = launch === null ? (process.env.IDLEBIZ_ROOT_DIR ?? null) : launch.root;
  const root = rootDir(home, override === "" ? null : override, process.cwd());

  return logsDir(packaged, home, app.getPath("appData"), root);
};

const strayMethodOf = (line: string) => {
  try {
    return z.object({ method: z.string() }).safeParse(parseJson(line)).data?.method ?? null;
  } catch {
    return null;
  }
};

const start = async () => {
  const launch = packagedLaunch();
  const logFile = mainLogPath(logsFolder(launch));
  const log = createMainLog(logFile);
  writeShellLogTo(log);

  const runtime = resolveRuntime({
    appPath: app.getAppPath(),
    execPath: process.execPath,
    packaged,
    resourcesPath: process.resourcesPath,
  });

  const main = startMain<RelayMethod>(
    {
      args: SERVE_ARGS,
      entry: path.join(runtime.cliDir, SERVE_ENTRY),
      env: mainEnv(process.env, launch),
      log: log.append,
      node: runtime.node,
      note: (line) => {
        const method = strayMethodOf(line.replace(/^\[main\] /u, ""));

        if (method !== null && !packaged && !unheard.has(method)) {
          unheard.add(method);
          void dialog.showMessageBox({
            detail: `Main sent the shell something it cannot read, so it did nothing with it.\n\n${line}`,
            message: "The shell and main disagree",
            type: "warning",
          });
        }

        console.error(line);
        log.append(line);
      },
      quit: "quit",
    },
    {
      listen,
      lost: (code) => {
        void fail(
          "IdleBiz stopped",
          `The office stopped unexpectedly (${describeExit(code)}). Your company is saved; open IdleBiz again to carry on.\n\nWhat happened is in ${logFile}.`,
        );
      },
    },
  );

  holdMain(main);

  const hello: LaunchHello = {
    openedAtLogin: launchedAtLogin(),
    packaged,
    pageDevUrl: packaged ? null : `http://localhost:${DEV_PORT}`,
    vault: openVault(packaged),
  };

  try {
    await main.boot("hello", hello, z.null(), HELLO_TIMEOUT_MS);
  } catch (error) {
    if (heldMain() === null) {
      return;
    }

    const what =
      error instanceof MainLateError
        ? `The office did not finish starting within ${HELLO_TIMEOUT_MS / 1000} seconds, so IdleBiz stopped it. Open IdleBiz again to try once more.`
        : `The office could not open your company: ${String(error)}`;

    if (error instanceof MainLateError) {
      takeMain();
    }

    await fail("IdleBiz couldn't start", `${what}\n\nWhat happened is in ${logFile}.`);

    return;
  }

  if (hello.openedAtLogin) {
    app.dock?.hide();

    return;
  }

  try {
    await createWindow();
  } catch (error) {
    await fail("IdleBiz couldn't start", `The window would not open: ${String(error)}`);
  }
};

const menu = () =>
  Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    ...(packaged ? [] : [{ role: "viewMenu" as const }]),
    { role: "windowMenu" },
  ]);

const quitOnSignals = () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      app.quit();
    });
  }
};

const run = () => {
  if (!packaged) {
    app.setPath("userData", path.join(app.getPath("appData"), "IdleBiz (dev)"));
  }

  if (packaged && !app.requestSingleInstanceLock()) {
    app.quit();

    return;
  }

  app.enableSandbox();
  quitOnSignals();
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => null);
  app.on("before-quit", (event) => {
    markQuitting();
    const main = takeMain();

    if (main === null || main.exited()) {
      return;
    }

    event.preventDefault();
    void (async () => {
      await main.stop();
      app.exit(0);
    })();
  });

  void (async () => {
    await app.whenReady();
    Menu.setApplicationMenu(menu());

    try {
      await start();
    } catch (error) {
      await fail("IdleBiz couldn't start", String(error));
    }
  })();
};

run();
