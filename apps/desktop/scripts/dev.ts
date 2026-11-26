import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createServer } from "vite";
import { z } from "zod";

const packageRoot = path.resolve(import.meta.dirname, "..");
const shellSources = path.join(packageRoot, "src", "shell");
const mainBundle = path.resolve(packageRoot, "..", "cli", "dist");
const QUIET_MS = 300;

const electronBinary = z.string().parse(createRequire(import.meta.url)("electron"));

const log = (line: string) => {
  process.stdout.write(`[dev] ${line}\n`);
};

const buildShell = () => {
  const built = spawnSync("pnpm", ["exec", "electron-vite", "build"], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  return built.status === 0;
};

const page = await createServer({
  configFile: path.join(packageRoot, "vite.config.ts"),
  mode: "development",
});

await page.listen();

log(`the page's dev server is up: ${page.resolvedUrls?.local.join(" ") ?? ""}`);

let shell: ChildProcess | null = null;
let stopping = false;
let restarting: Promise<void> | null = null;
let shellChanged = false;
let changedAgain = false;

const stopShell = async () => {
  const running = shell;
  shell = null;

  if (running === null || running.exitCode !== null || running.signalCode !== null) {
    return;
  }

  const exited = once(running, "exit");
  running.kill("SIGTERM");
  await exited;
};

const finish = async (code: number) => {
  if (stopping) {
    return;
  }

  stopping = true;
  await stopShell();
  await page.close();
  process.exit(code);
};

const startShell = () => {
  const started = spawn(electronBinary, [packageRoot], { cwd: packageRoot, stdio: "inherit" });
  shell = started;
  started.once("exit", (code) => {
    if (shell === started && !stopping) {
      log(`the app quit (${code ?? "a signal"})`);
      void finish(code ?? 0);
    }
  });
};

const restartOnce = async () => {
  changedAgain = false;
  await stopShell();

  if (shellChanged) {
    shellChanged = false;

    if (!buildShell()) {
      log("the shell did not build: fix it and save again");

      return false;
    }
  }

  if (stopping) {
    return false;
  }

  startShell();

  return changedAgain;
};

const restart = async () => {
  let again = await restartOnce();

  while (again) {
    again = await restartOnce();
  }
};

let quiet: NodeJS.Timeout | null = null;

const changed = (what: string, ofShell: boolean) => {
  shellChanged ||= ofShell;

  if (quiet !== null) {
    clearTimeout(quiet);
  }

  quiet = setTimeout(() => {
    quiet = null;

    if (restarting !== null) {
      changedAgain = true;

      return;
    }

    log(`${what} changed: restarting the app`);
    restarting = restart().finally(() => {
      restarting = null;
    });
  }, QUIET_MS);
};

if (!buildShell()) {
  await finish(1);
}

startShell();

watch(shellSources, { recursive: true }, () => {
  changed("the shell", true);
});

watch(mainBundle, { recursive: true }, () => {
  changed("main", false);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void finish(0);
  });
}
