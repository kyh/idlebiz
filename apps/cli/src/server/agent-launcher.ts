// An employee calls the company's tools by typing `idlebiz …` in its shell (commands/tools.ts). This
// package's own bin finds node through `#!/usr/bin/env node`, and the Mac the app runs on may have
// none, so main writes the runs a launcher of its own: a `sh` script that runs the node main runs on
// with the CLI main was started from, written at each boot, since the app may have moved since the
// last. Its folder goes first on each run's PATH, and no run writes it: it sits in the save's root,
// outside every folder a run writes.

import path from "node:path";
import { atomicWrite } from "./lib/fs";
import { shellQuote } from "./lib/shell-quote";

const CLI_BIN_NAME = "idlebiz";

const agentLauncherScript = (node: string, cliEntry: string): string =>
  [
    "#!/bin/sh",
    "# written by IdleBiz at each boot: the node it runs on and the CLI it ships",
    `exec ${shellQuote(node)} ${shellQuote(cliEntry)} "$@"`,
    "",
  ].join("\n");

/** Writes the launcher into `dir`, running `cliEntry` on `node`. */
export const writeAgentLauncher = (dir: string, node: string, cliEntry: string): void => {
  atomicWrite(path.join(dir, CLI_BIN_NAME), agentLauncherScript(node, cliEntry), { mode: 0o755 });
};

/** `basePath` with the launcher's folder first, so a run's `idlebiz` is main's. */
export const pathWithLauncher = (dir: string, basePath = ""): string =>
  basePath === "" ? dir : `${dir}${path.delimiter}${basePath}`;
