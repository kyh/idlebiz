import { lexFlat, lexLine } from "./shell-lexer";
import type { Command, Pipeline, Words } from "./shell-lexer";

// A command line is split as bash would split it, read loosely as well where another
// shell may split it apart, and seen through every wrapper that runs another command, so a
// rule reads a program's own words and never the text of a quoted argument. Heredoc
// text is data unless a shell or `source` reads it, or a substitution may print it as
// a command's name.

/** A program as invoked: its name without a path, every word after it, and what its command's redirections name. */
export interface Call {
  program: string;
  args: Words;
  redirects: Words;
  /** Whether the shell hands it these words exactly: its command was read literal, from text no shell filled in first. */
  literal: boolean;
}

/** How a program reads its options. */
export interface Grammar {
  /** Options that take a value, as the next word or attached (`-uroot`, `--user=root`). */
  valued: ReadonlySet<string>;
  /** getopt_long also takes any unambiguous prefix of a long option (`--sig` for `--signal`). */
  abbreviates: boolean;
  /** pflag reads `-X=GET` as `-X GET`, where getopt gives `-X` the value `=GET`. */
  shortEquals: boolean;
}

/** A vocabulary written as words separated by whitespace, as a man page lists them. */
export const wordsOf = (text: string): ReadonlySet<string> =>
  new Set(text.split(/\s+/u).filter((word) => word !== ""));

export const gnu = (valued: string): Grammar => ({
  abbreviates: true,
  shortEquals: false,
  valued: wordsOf(valued),
});
export const exact = (valued = ""): Grammar => ({
  abbreviates: false,
  shortEquals: false,
  valued: wordsOf(valued),
});
/** Go's pflag, which cobra CLIs like gh parse with. */
export const pflag = (valued = ""): Grammar => ({
  abbreviates: false,
  shortEquals: true,
  valued: wordsOf(valued),
});

export interface Flag {
  name: string;
  value: string | undefined;
}

/** The options one word sets, and whether it took the next word as a value. */
interface Taken {
  flags: Flag[];
  next: boolean;
}

const longName = (name: string, grammar: Grammar): string => {
  if (!grammar.abbreviates || grammar.valued.has(name)) {
    return name;
  }
  const [only, ...others] = [...grammar.valued].filter((option) => option.startsWith(name));
  return only !== undefined && others.length === 0 ? only : name;
};

/** A short cluster ends at its first option that takes a value (`-sXPOST`), or pflag's `-x=value`; `--name=value` carries its own. */
const optionsIn = (word: string, grammar: Grammar, next: string | undefined): Taken => {
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    if (equals !== -1) {
      const name = longName(word.slice(0, equals), grammar);
      return { flags: [{ name, value: word.slice(equals + 1) }], next: false };
    }
    const name = longName(word, grammar);
    const valued = grammar.valued.has(name);
    return { flags: [{ name, value: valued ? next : undefined }], next: valued };
  }
  const flags: Flag[] = [];
  for (let at = 1; at < word.length; at += 1) {
    const name = `-${word.charAt(at)}`;
    const attached = word.slice(at + 1);
    // pflag's `-x=value`, whatever the option takes; a lone `=` is the value itself.
    if (grammar.shortEquals && attached.length > 1 && attached.startsWith("=")) {
      flags.push({ name, value: attached.slice(1) });
      return { flags, next: false };
    }
    if (grammar.valued.has(name)) {
      flags.push({ name, value: attached === "" ? next : attached });
      return { flags, next: attached === "" };
    }
    flags.push({ name, value: undefined });
  }
  return { flags, next: false };
};

const isOption = (word: string): boolean => word.length > 1 && word.startsWith("-");

interface Options {
  flags: Flag[];
  /** Where the operands start: the command a wrapper runs, or a program's subcommand. */
  end: number;
}

/** Options up to the first operand, as getopt reads a wrapper's: what follows is the command it runs. */
export const leadingOptions = (words: Words, from: number, grammar: Grammar): Options => {
  const flags: Flag[] = [];
  let at = from;
  while (at < words.length) {
    const word = words[at] ?? "";
    if (word === "--") {
      return { end: at + 1, flags };
    }
    if (!isOption(word)) {
      break;
    }
    const taken = optionsIn(word, grammar, words[at + 1]);
    flags.push(...taken.flags);
    at += taken.next ? 2 : 1;
  }
  return { end: at, flags };
};

interface Arguments {
  flags: Flag[];
  operands: string[];
}

/** A program's words as pflag and curl read them: options wherever they sit among the operands (`gh api path -f x`). */
export const argumentsOf = (args: Words, grammar: Grammar): Arguments => {
  const read: Arguments = { flags: [], operands: [] };
  let at = 0;
  while (at < args.length) {
    const word = args[at] ?? "";
    if (word === "--") {
      read.operands.push(...args.slice(at + 1));
      break;
    }
    const taken = isOption(word) ? optionsIn(word, grammar, args[at + 1]) : null;
    if (taken === null) {
      read.operands.push(word);
    }
    read.flags.push(...(taken?.flags ?? []));
    at += taken?.next === true ? 2 : 1;
  }
  return read;
};

/** What a command runs besides itself: where each command it goes on to may start, and a script it hands a shell. */
interface Runs {
  next: readonly number[];
  script: string | null;
}

const RUNS_NOTHING: Runs = { next: [], script: null };

interface Wrapper {
  grammar: Grammar;
  /** Operands between the options and the command, like timeout's duration. */
  skip: number;
}

/** Programs that run the command after their own options: `timeout 60 git push` pushes. */
const WRAPPERS = new Map<string, Wrapper>([
  ["builtin", { grammar: exact(), skip: 0 }],
  ["caffeinate", { grammar: exact("-t -w"), skip: 0 }],
  ["doas", { grammar: exact("-a -C -u"), skip: 0 }],
  ["exec", { grammar: exact("-a"), skip: 0 }],
  ["nice", { grammar: gnu("-n --adjustment"), skip: 0 }],
  ["noglob", { grammar: exact(), skip: 0 }],
  ["nocorrect", { grammar: exact(), skip: 0 }],
  ["nohup", { grammar: exact(), skip: 0 }],
  ["stdbuf", { grammar: gnu("-e -i -o --error --input --output"), skip: 0 }],
  [
    "sudo",
    {
      grammar: gnu(`
        -C -D -g -p -R -r -T -t -U -u --chdir --chroot --close-from --command-timeout --group
        --other-user --prompt --role --type --user
      `),
      skip: 0,
    },
  ],
  ["time", { grammar: gnu("-f -o --format --output"), skip: 0 }],
  ["timeout", { grammar: gnu("-k -s --kill-after --signal"), skip: 1 }],
  [
    "xargs",
    {
      grammar: gnu(`
        -a -d -E -I -J -L -n -P -R -s -S --arg-file --delimiter --max-args --max-chars
        --max-lines --max-procs --process-slot-var
      `),
      skip: 0,
    },
  ],
]);

const lastValue = (flags: readonly Flag[], names: ReadonlySet<string>): string | null =>
  flags.findLast((flag) => names.has(flag.name))?.value ?? null;

const COMMAND = exact();
/** `command -v` only says where a program is. */
const LOOKUPS = new Set(["-v", "-V"]);

const commandRuns = (words: Words, from: number): Runs => {
  const { end, flags } = leadingOptions(words, from, COMMAND);
  return flags.some((flag) => LOOKUPS.has(flag.name))
    ? RUNS_NOTHING
    : { next: [end], script: null };
};

const ENV = gnu("-a -C -L -P -S -u -U --argv0 --chdir --split-string --unset");
const ENV_SPLIT = new Set(["-S", "--split-string"]);

const quoted = (word: string): string => `'${word.replaceAll("'", String.raw`'\''`)}'`;

const envRuns = (words: Words, from: number): Runs => {
  const { end, flags } = leadingOptions(words, from, ENV);
  const split = lastValue(flags, ENV_SPLIT);
  if (split !== null) {
    // The split words run with the operands after them: `env -S 'git' push` pushes.
    return { next: [], script: [split, ...words.slice(end).map(quoted)].join(" ") };
  }
  // A lone `-` is env's `-i`, not the program.
  return { next: [words[end] === "-" ? end + 1 : end], script: null };
};

/** find runs the words after each of these, up to its `;` or `+`. */
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const findRuns = (words: Words, from: number): Runs => ({
  next: words.flatMap((word, at) => (at >= from && FIND_ACTIONS.has(word) ? [at + 1] : [])),
  script: null,
});

/** bash's `coproc NAME { … }` names its coprocess and zsh's coproc never does, so either word may be the command. */
const coprocRuns = (_words: Words, from: number): Runs => ({
  next: [from, from + 1],
  script: null,
});

const FLOCK = gnu("-c -E -w --command --conflict-exit-code --timeout --wait");
const COMMAND_SCRIPT = new Set(["-c", "--command"]);

/** flock takes its lock file, then a command, or `-c SCRIPT`. */
const flockRuns = (words: Words, from: number): Runs => {
  const { end, flags } = leadingOptions(words, from, FLOCK);
  if (COMMAND_SCRIPT.has(words[end + 1] ?? "")) {
    return { next: [], script: words[end + 2] ?? null };
  }
  return { next: [end + 1], script: lastValue(flags, COMMAND_SCRIPT) };
};

const SCRIPT = gnu(`
  -B -c -E -F -I -m -O -T -t --command --echo --log-in --log-io --log-out --log-timing
  --logging-format --output-limit
`);

/** macOS `script` runs the command after its log file; util-linux's takes `-c SCRIPT`. */
const scriptRuns = (words: Words, from: number): Runs => ({
  next: [leadingOptions(words, from, SCRIPT).end + 1],
  script: lastValue(argumentsOf(words.slice(from), SCRIPT).flags, COMMAND_SCRIPT),
});

const SSH = exact("-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -Q -R -S -W -w");

/** ssh joins what follows the host into a line for the remote shell; options may come after the host too. */
const sshRuns = (words: Words, from: number): Runs => {
  const host = leadingOptions(words, from, SSH).end;
  const command = words.slice(leadingOptions(words, host + 1, SSH).end);
  return { next: [], script: command.length > 0 ? command.join(" ") : null };
};

const SU = gnu(`
  -c -g -G -s -w --command --group --session-command --shell --supp-group
  --whitelist-environment
`);
const SU_SCRIPT = new Set(["-c", "--command", "--session-command"]);

const suRuns = (words: Words, from: number): Runs => ({
  next: [],
  script: lastValue(argumentsOf(words.slice(from), SU).flags, SU_SCRIPT),
});

const WATCH = gnu("-n -q --equexit --interval");
const WATCH_EXEC = new Set(["-x", "--exec"]);

/**
 * watch hands its operands to `sh -c` joined by spaces, or with `-x` runs them as
 * they are. Words a shell reads back as themselves run the same either way, so,
 * as with eval, they are read once: reading both ways at every `watch` doubles the
 * work at each one.
 */
const watchRuns = (words: Words, from: number, plain: boolean): Runs => {
  const { end, flags } = leadingOptions(words, from, WATCH);
  return plain || flags.some((flag) => WATCH_EXEC.has(flag.name))
    ? { next: [end], script: null }
    : { next: [], script: words.slice(end).join(" ") };
};

/** Programs with a way of their own to name what they run; `plain` says a shell would read their words back as themselves. */
const RUNS_OWN = new Map<string, (words: Words, from: number, plain: boolean) => Runs>([
  ["command", commandRuns],
  ["coproc", coprocRuns],
  ["env", envRuns],
  ["find", findRuns],
  ["flock", flockRuns],
  ["script", scriptRuns],
  ["ssh", sshRuns],
  ["su", suRuns],
  ["watch", watchRuns],
]);

const SHELLS = new Set(["bash", "dash", "sh", "zsh"]);
const SHELL_OPTION = /^[-+]./u;
const SHELL_VALUED = new Set(["--init-file", "--rcfile"]);

/** The script `sh -c SCRIPT` runs: `c` may share a cluster (`-lc`), and each `o` takes a word (`-euo pipefail`). */
const shellScript = (words: Words, from: number): string | null => {
  let command = false;
  let at = from;
  while (at < words.length) {
    const word = words[at] ?? "";
    at += 1;
    if (word === "--" || word === "-") {
      break;
    }
    if (!SHELL_OPTION.test(word)) {
      return command ? word : null;
    }
    if (word.startsWith("--")) {
      at += SHELL_VALUED.has(word) ? 1 : 0;
    } else {
      command ||= word.startsWith("-") && word.includes("c");
      at += word.match(/[oO]/gu)?.length ?? 0;
    }
  }
  return command ? (words[at] ?? null) : null;
};

/** Programs that run a script they read, as a shell given none does: `. /dev/stdin <<EOF`, `source <(…)`. */
const SOURCES = new Set([".", "source"]);

/** npx, bunx, `pnpm exec`, `yarn dlx`, `npm x`: a package's bin by name, or the shell string after `-c`. */
const RUNNERS = new Set(["bunx", "npx", "pnpx"]);
const RUNS_PACKAGE = new Set(["dlx", "exec", "x"]);

/**
 * npx and `npm exec` give the next word to any option but npm's switches, unless
 * it looks like an option itself, and npm's valued options are too many to list.
 * So an option known as neither is read both ways: the command may start at its
 * value or after it. Names are written without their dashes, as npx compares them.
 */
const RUNNER_VALUED = wordsOf(`
  C c cache call node-arg npm p package prefix registry script-shell shell userconfig
`);
const RUNNER_SWITCHES = wordsOf(
  "bun h help ignore-scripts no-install q quiet s silent v version y yes",
);
const RUNNER_SCRIPT = new Set(["c", "call"]);
const LEADING_DASHES = /^-+/u;

const runner = (words: Words, from: number): Runs => {
  const next: number[] = [];
  let script: string | null = null;
  let at = from;
  while (at < words.length) {
    const word = words[at] ?? "";
    if (word === "--" || !word.startsWith("-")) {
      next.push(word === "--" ? at + 1 : at);
      break;
    }
    const [key = "", ...attached] = word.replace(LEADING_DASHES, "").split("=");
    const following = words[at + 1];
    const valued = RUNNER_VALUED.has(key);
    const takes =
      attached.length === 0 &&
      following !== undefined &&
      !RUNNER_SWITCHES.has(key) &&
      (valued || !following.startsWith("-"));
    if (RUNNER_SCRIPT.has(key)) {
      script = attached.length > 0 ? attached.join("=") : (following ?? null);
    }
    if (takes && !valued) {
      next.push(at + 1);
    }
    at += takes ? 2 : 1;
  }
  return { next, script };
};

interface PackageManager {
  grammar: Grammar;
  /** pnpm and yarn run a local bin named in place of a command: `pnpm vercel deploy`. */
  bins: boolean;
}

export const PACKAGE_MANAGERS = new Map<string, PackageManager>([
  ["bun", { bins: false, grammar: exact("-c -F --config --cwd --env-file --filter") }],
  [
    "npm",
    {
      bins: false,
      grammar: gnu("-C -w --cache --loglevel --prefix --registry --userconfig --workspace"),
    },
  ],
  [
    "pnpm",
    {
      bins: true,
      grammar: gnu(`
        -C -F --dir --filter --filter-prod --loglevel --reporter --store-dir --test-pattern
        --workspace-concurrency
      `),
    },
  ],
  [
    "yarn",
    {
      bins: true,
      grammar: exact("--cache-folder --cwd --modules-folder --mutex --network-timeout --registry"),
    },
  ],
]);

const packageManager = (manager: PackageManager, words: Words, from: number): Runs => {
  const { end } = leadingOptions(words, from, manager.grammar);
  const command = words[end];
  if (command !== undefined && RUNS_PACKAGE.has(command)) {
    return runner(words, end + 1);
  }
  return { next: manager.bins ? [end] : [], script: null };
};

/** Where the command named just before `from` goes on to, and any script it hands a shell. */
const runs = (words: Words, from: number, program: string, plain: boolean): Runs => {
  if (SHELLS.has(program)) {
    return { next: [], script: shellScript(words, from) };
  }
  if (program === "eval") {
    return plain
      ? { next: [from], script: null }
      : { next: [], script: words.slice(from).join(" ") };
  }
  const own = RUNS_OWN.get(program);
  if (own !== undefined) {
    return own(words, from, plain);
  }
  if (RUNNERS.has(program)) {
    return runner(words, from);
  }
  const manager = PACKAGE_MANAGERS.get(program);
  if (manager !== undefined) {
    return packageManager(manager, words, from);
  }
  const wrapper = WRAPPERS.get(program);
  if (wrapper === undefined) {
    return RUNS_NOTHING;
  }
  return { next: [leadingOptions(words, from, wrapper.grammar).end + wrapper.skip], script: null };
};

/** Wrappers no rule reads: only what they run is recorded. */
const PASS_THROUGH = new Set([...WRAPPERS.keys(), ...RUNNERS, "command", "coproc", "env", "eval"]);

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/u;
/** Reserved words a command's name may follow, each opening, joining or closing a compound command: `if git push`. */
const RESERVED = wordsOf("! { } always do done elif else esac fi if then until while");
/** Reserved words whose own operand comes before the command's name: `function NAME`, zsh's `repeat COUNT`. */
const TAKES_OPERAND = wordsOf("function repeat");
/** Arithmetic, which zsh's short forms run a command straight after: `while (( n-- )) git push`. */
const ARITHMETIC = "((";
/**
 * Words zsh may start another command right after, within the same one: the `{`
 * opening a body past any number of function names (`function f g { git push }`),
 * the `}` closing a condition's group and the `]]` closing its test
 * (`if [[ -n $x ]] git push`). A start too many only names more commands to judge,
 * so one is taken after each; the lexer, whose `case` count a start too many would
 * mislead, reads them exactly.
 */
const RESTARTS = wordsOf("{ } ]]");

/** How many words at `at` come before a command's name, 0 when it is the name. */
const leadingWords = (words: Words, at: number): number => {
  const word = words[at] ?? "";
  if (TAKES_OPERAND.has(word)) {
    return 2;
  }
  const arithmeticFor = word === "for" && (words[at + 1] ?? "").startsWith(ARITHMETIC);
  return arithmeticFor || ASSIGNMENT.test(word) || RESERVED.has(word) || word.startsWith(ARITHMETIC)
    ? 1
    : 0;
};

/** A word eval would read back as itself, so a line of them needs no second reading. */
const PLAIN = /^[^\s'"\\`$;&|<>()#]*$/u;
/** A name bash only knows once it expands it: `$(cat <<EOF … EOF)` runs whatever the substitution prints. */
const EXPANDED = /[$`]/u;
/**
 * Programs that change the words of what they run after the shell has read them:
 * xargs appends its input or fills it in, find fills in `{}`, and eval and watch's
 * shell expand them again.
 */
const REWRITES = new Set(["eval", "find", "watch", "xargs"]);
/** `npx vercel@latest` runs vercel; a leading `@` is a package scope. */
const PACKAGE_VERSION = /(?!^)@[^@/]*$/u;

const programOf = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1).replace(PACKAGE_VERSION, "");

/** A simple command's calls, each wrapper seen through to what it runs, and the scripts it hands a shell. */
interface Stage {
  calls: Call[];
  scripts: string[];
  /** Whether its words, and so its scripts, reach it as read. */
  literal: boolean;
  /** A shell given no script reads one from its input: `bash <<EOF`, `cat <<EOF | sh`, and so does `source`. */
  readsInput: boolean;
  /** Its name comes from an expansion, so what its substitutions were fed may be what runs. */
  runsPrinted: boolean;
}

/**
 * `verbatim` says whether the text the command was read from is what its shell runs: a script
 * handed on in a word the outer shell expands is not. `plain` says whether the words eval or
 * watch hand a shell are read where they stand instead of as a script: by default, when a
 * shell would read each back as itself.
 */
const stageOf = (
  { words, redirects, literal: read }: Command,
  verbatim: boolean,
  plain = words.every((word) => PLAIN.test(word)),
): Stage => {
  const literal = read && verbatim;
  const stage: Stage = { calls: [], literal, readsInput: false, runsPrinted: false, scripts: [] };
  if (words.length === 0) {
    // Redirections alone still open their files for what runs there: `(cat) < ~/.ssh/id_rsa | …`.
    stage.calls.push({ args: [], literal, program: "", redirects });
  }
  // Every command a wrapper runs starts after it, so one pass in order meets each start after whatever named it.
  // A quoted `}` or `]]` looks like a bare one, so a command may start after each.
  const starts = new Set([0, ...words.flatMap((word, at) => (RESTARTS.has(word) ? [at + 1] : []))]);
  let managed = false;
  let rewritten = false;
  for (let from = 0; from < words.length; from += 1) {
    if (!starts.has(from)) {
      continue;
    }
    let start = from;
    for (let lead = leadingWords(words, start); lead > 0; lead = leadingWords(words, start)) {
      start += lead;
      // A start passed on the way names this same command: `} } git push` reads it once.
      starts.delete(start);
    }
    const head = words[start];
    if (head === undefined) {
      continue;
    }
    const program = programOf(head);
    // A package manager run by another is already among its words, which are all the publish rule reads.
    const repeated = managed && PACKAGE_MANAGERS.has(program);
    if (!PASS_THROUGH.has(program) && !repeated) {
      stage.calls.push({
        args: words.slice(start + 1),
        literal: literal && !rewritten,
        program,
        redirects,
      });
    }
    managed ||= PACKAGE_MANAGERS.has(program);
    rewritten ||= REWRITES.has(program);
    const next = runs(words, start + 1, program, plain);
    if (next.script !== null) {
      stage.scripts.push(next.script);
    }
    stage.readsInput ||= SOURCES.has(program) || (SHELLS.has(program) && next.script === null);
    stage.runsPrinted ||= EXPANDED.test(head);
    for (const at of next.next) {
      starts.add(at);
    }
  }
  return stage;
};

/**
 * Where shells may disagree on where a substitution ends, a word read here
 * inside one, or as a command after it, may be an argument of the command
 * around it: dash hands `publish` to npm in `npm $(echo $(( x ) ))) publish`.
 * So each call a flat reading finds of a program in `judged` is read again
 * with the words after it, up to that program's next call, which takes the
 * rest. Stopping there keeps a long line linear.
 */
const tailsOf = (flat: readonly Pipeline[], judged: ReadonlySet<string>): Call[][] => {
  const commands = flat.flat();
  const words = commands.flatMap((command) => command.words);
  const latest = new Map<string, { call: Call; after: number }>();
  const tails: Call[][] = [];
  const close = (program: string, end: number): void => {
    const open = latest.get(program);
    if (open !== undefined) {
      tails.push([{ ...open.call, args: [...open.call.args, ...words.slice(open.after, end)] }]);
    }
  };
  let at = 0;
  for (const command of commands) {
    const start = at;
    at += command.words.length;
    for (const call of stageOf(command, false).calls) {
      if (judged.has(call.program)) {
        close(call.program, start);
        latest.set(call.program, { after: at, call });
      }
    }
  }
  for (const program of latest.keys()) {
    close(program, words.length);
  }
  return tails;
};

/** Past this many scripts inside scripts, which heredocs can nest without escaping, a script is read flat. */
const MAX_SCRIPT_DEPTH = 8;

/** A program word with a blank or an operator in it is a whole script someone quoted. */
const SCRIPT_IN_A_WORD = /[\s;&|<>()`$]/u;

const quotesScript = (command: Command): boolean => SCRIPT_IN_A_WORD.test(command.words[0] ?? "");

/** What a command line runs, as calls, and whether any of it reads a script from its input. */
interface Reading {
  pipelines: Call[][];
  /** `bash`, `source /dev/stdin`, `eval "$(cat)"`: what the line is fed may run. */
  reads: boolean;
}

/**
 * Every pipeline a command line runs, as calls. A script handed to a shell is
 * read as a line of its own, and so is the text a pipeline feeds a shell or
 * `source`, and the text a substitution may print as a command's name.
 * `readTexts` holds each such text already read and whether it reads its own
 * input: substitutions nest, so one heredoc reaches a command at every level,
 * and reading it at each would multiply the work by every level it passes.
 * `verbatim` says whether the shell runs `line` as written; a fed or printed
 * text never counts, since an unquoted heredoc's body is expanded first.
 */
const readingOf = (
  line: string,
  judged: ReadonlySet<string>,
  depth: number,
  readTexts: Map<string, boolean>,
  verbatim: boolean,
): Reading => {
  if (depth > MAX_SCRIPT_DEPTH) {
    // No script is followed this deep, so a wrapper's words are read where they stand: `watch … git push "$x"`.
    const flat = lexFlat(line).map((pipeline) =>
      pipeline.map((command) => ({ command, stage: stageOf(command, false, true) })),
    );
    return {
      pipelines: flat.map((pipeline) => pipeline.flatMap(({ stage }) => stage.calls)),
      reads: true,
    };
  }
  const readOnce = (text: string, literal: boolean): Reading => {
    // A text read as written is read again where the shell may have filled it in: only then are its calls not literal.
    const key = JSON.stringify([text, literal]);
    const known = readTexts.get(key);
    if (known !== undefined) {
      return { pipelines: [], reads: known };
    }
    // Until read, a text that meets itself again is taken to read its input.
    readTexts.set(key, true);
    const reading = readingOf(text, judged, depth + 1, readTexts, literal);
    readTexts.set(key, reading.reads);
    return reading;
  };
  let reads = false;
  const lexed = lexLine(line);
  const pipelines = lexed.pipelines.flatMap((pipeline) => {
    const stages = pipeline.map((command) => stageOf(command, verbatim));
    const scripts = stages.flatMap((stage) =>
      stage.scripts.map((script) => readOnce(script, stage.literal)),
    );
    const fed = stages.some((stage) => stage.readsInput) || scripts.some((script) => script.reads);
    const texts = pipeline.flatMap((command, index) => [
      ...(fed ? command.input : []),
      ...(fed || stages[index]?.runsPrinted === true ? command.printed.flat() : []),
    ]);
    const fedReadings = texts.map((text) => readOnce(text, false));
    // codex shows an approval's script whole, quoted into one word when it holds a `'`:
    // no program is named that, so it is the script the shell will run.
    const quotedScripts = pipeline.flatMap((command) =>
      quotesScript(command) ? [readOnce(command.words[0] ?? "", false)] : [],
    );
    reads ||=
      fed ||
      stages.some((stage) => stage.runsPrinted) ||
      fedReadings.some((reading) => reading.reads) ||
      quotedScripts.some((reading) => reading.reads);
    return [
      stages.flatMap((stage) => stage.calls),
      ...scripts.flatMap((script) => script.pipelines),
      ...fedReadings.flatMap((reading) => reading.pipelines),
      ...quotedScripts.flatMap((reading) => reading.pipelines),
    ];
  });
  return {
    pipelines: lexed.divergent ? [...pipelines, ...tailsOf(lexFlat(line), judged)] : pipelines,
    reads,
  };
};

/**
 * Every pipeline `line` runs, as calls. `judged` names the programs whose words the caller
 * reads: where shells read the line apart, each of their calls takes the words after it too.
 */
export const pipelinesOf = (line: string, judged: ReadonlySet<string>): Call[][] =>
  readingOf(line, judged, 0, new Map(), true).pipelines;
