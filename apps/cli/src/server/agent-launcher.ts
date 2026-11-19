import path from "node:path";
import { atomicWrite } from "./lib/fs";
import { shellQuote } from "./lib/shell-quote";

const CLI_BIN_NAME = "idlebiz";

const agentLauncherScript = (node: string, cliEntry: string) =>
  [
    "#!/bin/sh",
    "# written by IdleBiz at each boot: the node it runs on and the CLI it ships",
    `exec ${shellQuote(node)} ${shellQuote(cliEntry)} "$@"`,
    "",
  ].join("\n");

/** Writes the launcher into `dir`, running `cliEntry` on `node`. */
export const writeAgentLauncher = (dir: string, node: string, cliEntry: string) => {
  atomicWrite(path.join(dir, CLI_BIN_NAME), agentLauncherScript(node, cliEntry), { mode: 0o755 });
};

/** `basePath` with the launcher's folder first, so a run's `idlebiz` is main's. */
export const pathWithLauncher = (dir: string, basePath = "") =>
  basePath === "" ? dir : `${dir}${path.delimiter}${basePath}`;
