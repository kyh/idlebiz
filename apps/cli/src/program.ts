import { stripVTControlCharacters } from "node:util";
import { defineCommand, renderUsage, runCommand } from "citty";
import type { CommandDef } from "citty";
import { serveCommand } from "./commands/serve";
import { TOOL_VERBS, toolCommands, toolHelp } from "./commands/tools";
import { readCliVersion } from "./paths";

const program: CommandDef = defineCommand({
  meta: {
    description:
      "IdleBiz's server, which the desktop app runs, and the company's tools, which its employees call",
    name: "idlebiz",
    version: readCliVersion(),
  },
  subCommands: { serve: serveCommand, ...toolCommands() },
});

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

// citty colours what it renders whatever the stream; a pipe or a file gets the plain text
const forStream = (text: string, stream: NodeJS.WriteStream): string =>
  stream.isTTY ? text : stripVTControlCharacters(text);

// citty pads every row of a table to its longest, which an agent reading it pays for in spaces
const usage = async (): Promise<string> =>
  forStream(`${await renderUsage(program)}\n`, process.stdout).replaceAll(/[ \t]+$/gmu, "");

/** Whether `argv` asks for help: a flag before any `--`, past which every word is an argument. */
const asksHelp = (argv: readonly string[]): boolean => {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).some((word) => HELP_FLAGS.has(word));
};

/** A tool's verb as its name spells it (`ask_boss`), which an agent reading the docs may type. */
const verbFor = (word: string): string => {
  const kebab = word.replaceAll("_", "-");
  return TOOL_VERBS.has(kebab) ? kebab : word;
};

/**
 * Runs the command `argv` names, answering the exit code. Not citty's runMain, which answers every
 * failure with `process.exit(1)`: `serve` keeps the process after its run resolves, and stays up
 * until the shell lets it go. Failures go to stderr alone, since stdout is `serve`'s protocol and a
 * tool's answer.
 */
export const runCli = async (argv: readonly string[]): Promise<number> => {
  const [first, ...rest] = argv;
  const verb = first === undefined ? undefined : verbFor(first);
  const tool = verb === undefined ? undefined : TOOL_VERBS.get(verb);
  if (verb === undefined || HELP_FLAGS.has(verb) || (tool === undefined && asksHelp(argv))) {
    process.stdout.write(await usage());
    return 0;
  }
  if (tool !== undefined && asksHelp(rest)) {
    process.stdout.write(toolHelp(tool));
    return 0;
  }
  if (VERSION_FLAGS.has(verb)) {
    process.stdout.write(`${readCliVersion()}\n`);
    return 0;
  }
  try {
    await runCommand(program, { rawArgs: [verb, ...rest] });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(forStream(`idlebiz: ${message}\n`, process.stderr));
    return 1;
  }
};
