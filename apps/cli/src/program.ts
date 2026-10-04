import { stripVTControlCharacters } from "node:util";
import { defineCommand, renderUsage, runCommand } from "citty";
import type { CommandDef } from "citty";
import { serveCommand } from "./commands/serve";
import { readCliVersion } from "./paths";

const program: CommandDef = defineCommand({
  meta: {
    description: "IdleBiz's server, which the desktop app runs",
    name: "idlebiz",
    version: readCliVersion(),
  },
  subCommands: { serve: serveCommand },
});

const HELP_FLAGS = new Set(["--help", "-h"]);

// citty colours what it renders whatever the stream; a pipe or a file gets the plain text
const forStream = (text: string, stream: NodeJS.WriteStream): string =>
  stream.isTTY ? text : stripVTControlCharacters(text);
const VERSION_FLAGS = new Set(["--version", "-v"]);

/**
 * Runs the command `argv` names, answering the exit code. Not citty's runMain, which answers every
 * failure with `process.exit(1)`: `serve` keeps the process after its run resolves, and stays up
 * until the shell lets it go. Failures go to stderr alone, since stdout is `serve`'s protocol.
 */
export const runCli = async (argv: readonly string[]): Promise<number> => {
  const [first] = argv;
  if (first === undefined || HELP_FLAGS.has(first)) {
    process.stdout.write(forStream(`${await renderUsage(program)}\n`, process.stdout));
    return 0;
  }
  if (VERSION_FLAGS.has(first)) {
    process.stdout.write(`${readCliVersion()}\n`);
    return 0;
  }
  try {
    await runCommand(program, { rawArgs: [...argv] });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(forStream(`idlebiz: ${message}\n`, process.stderr));
    return 1;
  }
};
