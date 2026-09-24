import type { ToolAsk } from "@repo/agent-driver/tool-ask";
import type { HoldRuleId } from "./hold-rules";
import { lexFlat, lexLine } from "./shell-lexer";
import type { Command, Pipeline, Words } from "./shell-lexer";

// IdleBiz answers every permission ask both runners raise, so an unmatched command runs
// with the founder's privileges: the CLIs' own sandboxes do not stand behind it. Persist
// rule ids so approval cards can explain them.
// A command line is split as bash would split it, read loosely as well where another
// shell may split it apart, and seen through every wrapper that runs another command, so a
// rule reads a program's own words and never the text of a quoted argument. Heredoc
// text is data unless a shell or `source` reads it, or a substitution may print it as
// a command's name. It is a tripwire for outward actions, not a sandbox: what a script
// runs stays unseen, so `npm run deploy` or a script on disk goes through.
const RULE_IDS = [
  "deploy",
  "publish-package",
  "git-push",
  "github-create",
  "payments",
  "http-write",
  "remote-copy",
  "pipe-to-shell",
  "read-credentials",
  "destructive-outside",
  "write-outside",
] as const satisfies readonly HoldRuleId[];
export type RuleId = (typeof RULE_IDS)[number];

/** A program as invoked: its name without a path, every word after it, and what its command's redirections name. */
interface Call {
  program: string;
  args: Words;
  redirects: Words;
  /** Whether the shell hands it these words exactly: its command was read literal, from text no shell filled in first. */
  literal: boolean;
}

interface Rule {
  id: RuleId;
  /** Whether a pipeline runs something this rule holds. */
  holds: (pipeline: readonly Call[]) => boolean;
  /** Skip when everything the command targets is the game's own loopback API. */
  networked?: boolean;
}

/** How a program reads its options. */
interface Grammar {
  /** Options that take a value, as the next word or attached (`-uroot`, `--user=root`). */
  valued: ReadonlySet<string>;
  /** getopt_long also takes any unambiguous prefix of a long option (`--sig` for `--signal`). */
  abbreviates: boolean;
  /** pflag reads `-X=GET` as `-X GET`, where getopt gives `-X` the value `=GET`. */
  shortEquals: boolean;
}

/** A vocabulary written as words separated by whitespace, as a man page lists them. */
const wordsOf = (text: string): ReadonlySet<string> =>
  new Set(text.split(/\s+/u).filter((word) => word !== ""));

const gnu = (valued: string): Grammar => ({
  abbreviates: true,
  shortEquals: false,
  valued: wordsOf(valued),
});
const exact = (valued = ""): Grammar => ({
  abbreviates: false,
  shortEquals: false,
  valued: wordsOf(valued),
});
/** Go's pflag, which cobra CLIs like gh parse with. */
const pflag = (valued = ""): Grammar => ({
  abbreviates: false,
  shortEquals: true,
  valued: wordsOf(valued),
});

interface Flag {
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
const leadingOptions = (words: Words, from: number, grammar: Grammar): Options => {
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
const argumentsOf = (args: Words, grammar: Grammar): Arguments => {
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

const PACKAGE_MANAGERS = new Map<string, PackageManager>([
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

const anyCall =
  (test: (call: Call) => boolean) =>
  (pipeline: readonly Call[]): boolean =>
    pipeline.some(test);

const DEPLOY_TOOLS = wordsOf("fly netlify railway surge vercel wrangler");

/** Subcommands of the deploy CLIs that only read — everything else ships. */
const DEPLOY_TOOL_READS = wordsOf(`
  --help --version -h -v build certs dev domains env help inspect link list log login
  logout logs ls open projects pull secrets switch teams unlink whoami
`);

const PUBLISHES = new Set(["deprecate", "publish", "unpublish"]);

/** git's own options that take a value, before its subcommand. */
const GIT = exact(
  "-C -c --attr-source --config-env --git-dir --namespace --super-prefix --work-tree",
);

/** gh subcommands that change nothing on GitHub — every other one does. */
const GITHUB_READS = wordsOf(
  "checkout checks clone co diff download get list ls set-default status view watch",
);

/** gh commands whose subcommand is no verb on GitHub; `api` is judged by its flags instead. */
const GITHUB_ASIDE = wordsOf("api auth browse completion config help search status version");
const GITHUB_HELP = wordsOf("--help -h");

/** A gh command, and where its name sits among gh's words. */
interface GitHubCommand {
  at: number;
  name: string;
  subcommand: string | undefined;
}

/**
 * gh's command and subcommand, found among flags as cobra finds them: a bare
 * `--name` or `-x` takes the next word unless it is `--help`, the only switch gh
 * knows there. Reading an unknown flag as a switch would let
 * `gh issue -c view close 3`, which closes issue 3, pass for a view.
 */
const githubCommand = (args: Words): GitHubCommand | null => {
  const names: { at: number; word: string }[] = [];
  let at = 0;
  while (at < args.length && names.length < 2 && args[at] !== "--") {
    const word = args[at] ?? "";
    const valued =
      word.startsWith("-") &&
      !word.includes("=") &&
      (word.startsWith("--") || word.length === 2) &&
      word !== "--help";
    if (word !== "" && !word.startsWith("-")) {
      names.push({ at, word });
    }
    at += valued ? 2 : 1;
  }
  const [command, subcommand] = names;
  return command === undefined
    ? null
    : { at: command.at, name: command.word, subcommand: subcommand?.word };
};

const GITHUB_API = pflag(`
  -f -F -H -p -q -t -X --cache --field --header --hostname --input --jq --method
  --preview --raw-field --template
`);
const GITHUB_API_FIELDS = wordsOf("-f -F --field --input --raw-field");
/** Fields gh sends as written. It rewrites a typed one (`-F`): `@q.graphql` from a file, `@-` from stdin, `{owner}` or `{branch}` from the repository. */
const GITHUB_API_RAW = wordsOf("-f --raw-field");
const MUTATION = /\bmutation\b/u;

/** GraphQL always POSTs, so it writes when any query is a mutation or a text nobody here can read. gh sends other fields as variables. */
const graphqlWrites = (flags: readonly Flag[]): boolean =>
  flags.some((flag) => {
    if (flag.name === "--input") {
      return true;
    }
    const field = flag.value ?? "";
    if (!GITHUB_API_FIELDS.has(flag.name) || !field.startsWith("query=")) {
      return false;
    }
    return !GITHUB_API_RAW.has(flag.name) || MUTATION.test(field.slice("query=".length));
  });

/**
 * `gh api` sends a POST once it has a field, so only an explicit GET keeps it a read; pflag keeps
 * the last method given. A GraphQL query is judged by its text only when the shell passes every
 * word as read: one it fills in (`"$Q"`, `query=?utation*`, `-F "$X"`) may carry another query.
 */
const apiWrites = (args: Words, literal: boolean): boolean => {
  const { flags, operands } = argumentsOf(args, GITHUB_API);
  if (literal && operands[0] === "graphql") {
    return graphqlWrites(flags);
  }
  const method = flags.findLast((flag) => flag.name === "-X" || flag.name === "--method")?.value;
  if (method === undefined) {
    return flags.some((flag) => GITHUB_API_FIELDS.has(flag.name));
  }
  return method.toUpperCase() !== "GET";
};

/** `gh alias` subcommands that give gh nothing new to run. */
const ALIAS_READS = wordsOf("delete list ls");
const ALIAS_SET = pflag();
const ALIAS_SHELL = wordsOf("-s --shell");

/**
 * Whether `gh alias` leaves every later gh command as the policy reads it. `gh NAME …`
 * passes when a read verb or only help follows the name, and runs the alias's expansion
 * with those words after it, so an alias passes only as a read subcommand of a GitHub
 * command, which no word after it makes write. gh fills `$1` into the expansion's text
 * before splitting it (`'$1' view`), runs a `--shell` or `!` alias in a shell, and reads
 * `-` from stdin and `import` from a file nobody here read: all of those hold.
 */
const aliasReads = (call: Call, command: GitHubCommand): boolean => {
  if (command.subcommand !== "set") {
    return command.subcommand === undefined || ALIAS_READS.has(command.subcommand);
  }
  const { flags, operands } = argumentsOf(call.args.slice(command.at + 1), ALIAS_SET);
  // After `set` and the alias's name.
  const expansion = operands.at(2);
  if (
    !call.literal ||
    expansion === undefined ||
    expansion.includes("$") ||
    flags.some((flag) => ALIAS_SHELL.has(flag.name))
  ) {
    return false;
  }
  const [pipeline, ...others] = lexLine(expansion).pipelines;
  const [expanded, ...piped] = pipeline ?? [];
  if (
    expanded === undefined ||
    others.length > 0 ||
    piped.length > 0 ||
    !expanded.literal ||
    expanded.redirects.length > 0 ||
    expanded.input.length > 0
  ) {
    return false;
  }
  const aliased = githubCommand(expanded.words);
  return (
    aliased !== null &&
    !GITHUB_ASIDE.has(aliased.name) &&
    GITHUB_READS.has(aliased.subcommand ?? "")
  );
};

const changesGitHub = (call: Call): boolean => {
  const command = githubCommand(call.args);
  if (command === null) {
    return false;
  }
  if (command.name === "api") {
    return apiWrites(call.args.toSpliced(command.at, 1), call.literal);
  }
  if (command.name === "alias") {
    return !aliasReads(call, command);
  }
  if (GITHUB_ASIDE.has(command.name)) {
    return false;
  }
  // A leaf command, an alias or an extension runs with no subcommand: `gh copilot -p …`, `gh pm --squash`.
  return command.subcommand === undefined
    ? call.args.slice(command.at + 1).some((word) => !GITHUB_HELP.has(word))
    : !GITHUB_READS.has(command.subcommand);
};

const GITHUB_AUTH_STATUS = pflag("-h --hostname --jq --json --template");
const SHOWS_TOKEN = new Set(["-t", "--show-token"]);
const GITHUB_CONFIG_GET = pflag("-h --host");

/**
 * `gh auth token` prints the founder's GitHub token, and so do gh's git credential
 * helper, `auth status -t` and `config get -h <host> oauth_token`. Without a host
 * `config get` only says the key is missing, so holding it costs nothing.
 */
const printsGitHubToken = (args: Words): boolean => {
  const command = githubCommand(args);
  if (command?.name === "config") {
    return (
      command.subcommand === "get" &&
      argumentsOf(args, GITHUB_CONFIG_GET).operands.includes("oauth_token")
    );
  }
  return (
    command?.name === "auth" &&
    (command.subcommand === "token" ||
      command.subcommand === "git-credential" ||
      (command.subcommand === "status" &&
        argumentsOf(args, GITHUB_AUTH_STATUS).flags.some((flag) => SHOWS_TOKEN.has(flag.name))))
  );
};

const STRIPE_WRITES = wordsOf(`
  cancel capture charge confirm create delete pay payout payouts post refund refunds
  transfer transfers update
`);

const WRITE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

interface Sending {
  grammar: Grammar;
  /** Options that send a body whatever the method. */
  bodies: ReadonlySet<string>;
  methods: ReadonlySet<string>;
}

/** curl never abbreviates a long option. */
const CURL: Sending = {
  bodies: wordsOf(`
    -d -F -T --data --data-ascii --data-binary --data-raw --data-urlencode --form
    --form-string --json --upload-file
  `),
  grammar: exact(`
    -A -b -c -C -d -D -e -E -F -H -K -m -o -P -Q -r -t -T -u -U -w -x -X -y -Y -z --config
    --connect-timeout --cookie --cookie-jar --data --data-ascii --data-binary --data-raw
    --data-urlencode --dump-header --form --form-string --header --json --max-time --output
    --proxy --referer --request --retry --upload-file --url --user --user-agent --write-out
  `),
  methods: new Set(["-X", "--request"]),
};

const WGET: Sending = {
  bodies: new Set(["--body-data", "--body-file", "--post-data", "--post-file"]),
  grammar: gnu(`
    -a -A -B -D -e -i -I -l -n -o -O -P -Q -R -t -T -U -w -X --append-output --base
    --body-data --body-file --directory-prefix --execute --header --input-file --method
    --output-document --output-file --password --post-data --post-file --referer --tries
    --timeout --user --user-agent --wait
  `),
  methods: new Set(["--method"]),
};

const sends = (args: Words, sending: Sending): boolean =>
  argumentsOf(args, sending.grammar).flags.some(
    (flag) =>
      sending.bodies.has(flag.name) ||
      (sending.methods.has(flag.name) && WRITE_METHODS.has(flag.value?.toUpperCase() ?? "")),
  );

const COPIERS = new Set(["rsync", "scp"]);
const REMOTE_PATH = /^[\w.-]+@[\w.-]+:/u;
const REMOTE_LOGIN = /^[\w.-]+@[\w.-]+/u;

const FETCHERS = new Set(["curl", "wget"]);
const INTERPRETERS = wordsOf("bash dash python python3 sh zsh");

/** A path argument that leaves the workspace behind. */
const ESCAPES = String.raw`(?:~|\$(?:HOME\b|\{HOME\})|/(?:Users|home|etc|var|opt|System)\b|/Library\b)`;
/** Only where a deleter's word starts, bare or after an option's `=`: `rm notes.md~` clears an editor backup. */
const OUTSIDE = new RegExp(String.raw`^(?:--[\w-]+=)?${ESCAPES}`, "u");
/** Anywhere in a word: `../../../Library/LaunchAgents` from the workspace, or `-t/Users/me/x`. */
const NAMES_OUTSIDE = new RegExp(ESCAPES, "u");
const CREDENTIALS = new RegExp(String.raw`${ESCAPES}/\.(?:ssh|aws|gnupg|config/gh|netrc)\b`, "u");

const CREDENTIAL_READERS = wordsOf("base64 cat cp grep head less more openssl strings tail");
const KEYCHAIN_READS = new Set(["find-generic-password", "find-internet-password"]);
const DELETERS = new Set(["rm", "shred", "truncate"]);
const WRITERS = new Set(["chmod", "chown", "mv", "tee"]);

const RULES: readonly Rule[] = [
  {
    // Bare `vercel` deploys; exclude read-only subcommands rather than listing deploy verbs.
    holds: anyCall(
      (call) => DEPLOY_TOOLS.has(call.program) && !DEPLOY_TOOL_READS.has(call.args[0] ?? ""),
    ),
    id: "deploy",
  },
  {
    holds: anyCall(
      (call) => PACKAGE_MANAGERS.has(call.program) && call.args.some((arg) => PUBLISHES.has(arg)),
    ),
    id: "publish-package",
  },
  {
    holds: anyCall(
      (call) =>
        call.program === "git" && call.args[leadingOptions(call.args, 0, GIT).end] === "push",
    ),
    id: "git-push",
  },
  {
    // Exclude read-only verbs rather than listing writes.
    holds: anyCall((call) => call.program === "gh" && changesGitHub(call)),
    id: "github-create",
  },
  {
    holds: anyCall(
      (call) => call.program === "stripe" && call.args.some((arg) => STRIPE_WRITES.has(arg)),
    ),
    id: "payments",
  },
  {
    holds: anyCall(
      (call) =>
        (call.program === "curl" && sends(call.args, CURL)) ||
        (call.program === "wget" && sends(call.args, WGET)),
    ),
    id: "http-write",
    networked: true,
  },
  {
    holds: anyCall(
      (call) =>
        (COPIERS.has(call.program) && call.args.some((arg) => REMOTE_PATH.test(arg))) ||
        (call.program === "ssh" && call.args.some((arg) => REMOTE_LOGIN.test(arg))),
    ),
    id: "remote-copy",
    networked: true,
  },
  {
    holds: (pipeline) => {
      const fetched = pipeline.findIndex((call) => FETCHERS.has(call.program));
      return (
        fetched !== -1 && pipeline.slice(fetched + 1).some((call) => INTERPRETERS.has(call.program))
      );
    },
    id: "pipe-to-shell",
    networked: true,
  },
  {
    holds: anyCall(
      (call) =>
        (CREDENTIAL_READERS.has(call.program) && call.args.some((arg) => CREDENTIALS.test(arg))) ||
        // A redirection hands the file to whatever runs: `curl -d @- … < ~/.ssh/id_rsa`.
        call.redirects.some((target) => CREDENTIALS.test(target)) ||
        (call.program === "security" && KEYCHAIN_READS.has(call.args[0] ?? "")) ||
        (call.program === "gh" && printsGitHubToken(call.args)),
    ),
    id: "read-credentials",
  },
  {
    holds: anyCall(
      (call) => DELETERS.has(call.program) && call.args.some((arg) => OUTSIDE.test(arg)),
    ),
    id: "destructive-outside",
  },
  {
    holds: anyCall(
      (call) =>
        (WRITERS.has(call.program) && call.args.some((arg) => NAMES_OUTSIDE.test(arg))) ||
        (call.program === "dd" &&
          call.args.some((arg) => arg.startsWith("of=") && NAMES_OUTSIDE.test(arg))),
    ),
    id: "write-outside",
  },
];

/** Every program whose words a rule reads. A rule reading another names it here too, or a line shells read apart can hand that program a word unseen. */
const RULE_PROGRAMS = new Set([
  ...DEPLOY_TOOLS,
  ...PACKAGE_MANAGERS.keys(),
  ...COPIERS,
  ...CREDENTIAL_READERS,
  ...DELETERS,
  ...FETCHERS,
  ...WRITERS,
  "dd",
  "gh",
  "git",
  "security",
  "ssh",
  "stripe",
]);

/**
 * Where shells may disagree on where a substitution ends, a word read here
 * inside one, or as a command after it, may be an argument of the command
 * around it: dash hands `publish` to npm in `npm $(echo $(( x ) ))) publish`.
 * So each call a flat reading finds of a program a rule reads is read again
 * with the words after it, up to that program's next call, which takes the
 * rest. Stopping there keeps a long line linear.
 */
const tailsOf = (flat: readonly Pipeline[]): Call[][] => {
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
      if (RULE_PROGRAMS.has(call.program)) {
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
const pipelinesOf = (
  line: string,
  depth = 0,
  readTexts = new Map<string, boolean>(),
  verbatim = true,
): Reading => {
  if (depth > MAX_SCRIPT_DEPTH) {
    return {
      // No script is followed this deep, so a wrapper's words are read where they stand: `watch … git push "$x"`.
      pipelines: lexFlat(line).map((pipeline) =>
        pipeline.flatMap((command) => stageOf(command, false, true).calls),
      ),
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
    const reading = pipelinesOf(text, depth + 1, readTexts, literal);
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
    const quotedScripts = pipeline.flatMap((command) => {
      const [program] = command.words;
      return program !== undefined && SCRIPT_IN_A_WORD.test(program)
        ? [readOnce(program, false)]
        : [];
    });
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
    pipelines: lexed.divergent ? [...pipelines, ...tailsOf(lexFlat(line))] : pipelines,
    reads,
  };
};

const LOOPBACK_HOST = String.raw`https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)`;
const LOOPBACK_URL = new RegExp(`^(?:${LOOPBACK_HOST}|file:|about:)`, "u");
const onLoopback = (url: string | null): boolean => url !== null && LOOPBACK_URL.test(url);

/**
 * agent-browser's global options that take a value. It drops these and its
 * switches from anywhere in its words, and the first word left is its verb, as
 * its `clean_args` reads them. A valued option missing here would hand its value
 * the verb's place (`--model snapshot click @e1` clicks), so this keeps every
 * version's, 0.38's `--input-mode` too.
 */
const BROWSER_VALUED = wordsOf(`
  -p --action-policy --allowed-domains --args --ca-cert --cdp --color-scheme --config
  --confirm-actions --device --download-path --enable --engine --executable-path --extension
  --headers --idle-timeout --init-script --input-mode --max-output --model --namespace
  --profile --provider --proxy --proxy-bypass --restore-check-fn --restore-check-text
  --restore-check-url --restore-save --screenshot-dir --screenshot-format --screenshot-quality
  --session --session-name --state --user-agent
`);
/** Its switches, each of which also takes a `true` or `false` after it: `--headed false`. */
const BROWSER_SWITCHES = wordsOf(`
  -q -v --allow-file-access --annotate --auto-connect --confirm-interactive
  --content-boundaries --debug --fix --headed --hide-scrollbars --ignore-https-errors --json
  --no-auto-dialog --no-ca-cert --no-pin-tab --no-webmcp --offline --pin-tab --quick --quiet
  --verbose --webgpu
`);

/** Verbs that neither change nor move a page, and the help and version it prints in a verb's place. */
const PAGE_READS = wordsOf(`
  --help --version -h -V console errors get is pdf read screenshot scroll scrollinto
  scrollintoview session skills snapshot wait
`);
/**
 * Reads that go to the first word after them without two leading dashes, as
 * agent-browser picks it: `open -x` goes to `-x`. `open` alone only starts the browser.
 */
const OPENS = wordsOf("goto navigate open");
/** Reads that change which page the next step acts on. */
const NAVIGATES = wordsOf(`
  a11y back close connect diff exit forward frame pushstate quit record tab vitals web-vitals
  window
`);
/** Acts that set a value and leave the page where it was: any other act can take it anywhere. */
const SETS = wordsOf("check fill type uncheck upload");
/** Steps the command does not show: an AI at the wheel, a batch (its steps can be strings, JSON or stdin), a saved login's own page. */
const BROWSER_BLIND = new Set(["auth login", "batch", "chat", "mcp"]);
/**
 * Options that bring code no page read now can vouch for: scripts for pages the
 * browser has yet to open, an extension whose content scripts run on every later
 * page, the browser's own flags (`--load-extension`), a browser binary that may be
 * a wrapper, and a config file that can set any of them.
 */
const BLIND_OPTIONS = wordsOf(
  "--args --config --executable-path --extension --init-script --restore-check-fn",
);
/**
 * agent-browser names the session a command without `--session` uses "default",
 * unless AGENT_BROWSER_SESSION names another, so "" and "default" are one session
 * or two and nothing here can tell. A step that may move either one's page leaves
 * the other's unknown; reading one for the other would ask the wrong session.
 */
const SESSION_ALIASES = new Map([
  ["", "default"],
  ["default", ""],
]);

/** What one agent-browser step does to its session's page. */
type PageEffect =
  | { does: "blind" }
  | { does: "read" }
  | { does: "open"; url: string }
  | { does: "move" }
  | { does: "act"; moves: boolean };
/** A step and the session it runs in; "" is the one a command without `--session` uses. */
type BrowserStep = PageEffect & { session: string };

/** A command's words as agent-browser reads them. */
interface BrowserWords {
  /** Each global option given, by name: its value, or `true` or `false` for a switch. The last given wins, as there. */
  options: Map<string, string>;
  /** Its verb, then the verb's own words: the global options gone. */
  words: string[];
}

const browserWords = (args: Words): BrowserWords => {
  const options = new Map<string, string>();
  const words: string[] = [];
  let at = 0;
  while (at < args.length) {
    const word = args[at] ?? "";
    const next = args[at + 1];
    if (BROWSER_VALUED.has(word)) {
      if (next !== undefined) {
        options.set(word, next);
      }
      at += 2;
    } else if (BROWSER_SWITCHES.has(word)) {
      const given = next === "true" || next === "false";
      options.set(word, given ? next : "true");
      at += given ? 2 : 1;
    } else {
      words.push(word);
      at += 1;
    }
  }
  return { options, words };
};

/**
 * Whether the command points its session at another browser: agent-browser sends
 * a launch for these even to a running session, and reconnects when the target
 * changes, so its verb acts on a page no read before the command saw.
 */
const reconnects = (options: ReadonlyMap<string, string>): boolean =>
  options.has("--cdp") ||
  options.has("--provider") ||
  options.has("-p") ||
  options.get("--auto-connect") === "true";

/** Judged by its verb's place, from a list of reads: a verb nobody listed is an act. */
const verbEffect = (call: Call, { options, words }: BrowserWords): PageEffect => {
  const [verb] = words;
  if (
    // A word the shell fills in may become any verb, option or session: `wait $F "…"`.
    !call.literal ||
    // An empty `--session` is a session of its own, and the live read takes "" for none given.
    options.get("--session") === "" ||
    BROWSER_BLIND.has(verb ?? "") ||
    BROWSER_BLIND.has(words.slice(0, 2).join(" ")) ||
    [...options.keys()].some((name) => BLIND_OPTIONS.has(name))
  ) {
    return { does: "blind" };
  }
  if (verb === undefined) {
    return { does: "read" };
  }
  // `wait --fn` runs its expression in the page, which can do anything a click can; `-f` is its short form only there.
  if (words.includes("--fn") || (verb === "wait" && words.includes("-f"))) {
    return { does: "act", moves: true };
  }
  if (OPENS.has(verb)) {
    const url = words.slice(1).find((word) => !word.startsWith("--"));
    return url === undefined ? { does: "read" } : { does: "open", url };
  }
  if (PAGE_READS.has(verb)) {
    return { does: "read" };
  }
  if (NAVIGATES.has(verb)) {
    return { does: "move" };
  }
  return { does: "act", moves: !SETS.has(verb) };
};

/**
 * What one agent-browser command does to its session's page, in order: a reconnect is a move
 * before its verb. `--namespace` runs it in another daemon's browser, which the live read never
 * asks, under session names that may be this one's for all anyone here knows. So it meets a page
 * nobody knows, and even its open leaves the name's page unknown: taking that URL as the name's
 * would vouch for a page in another browser.
 */
const browserSteps = (call: Call): BrowserStep[] => {
  const read = browserWords(call.args);
  const session = read.options.get("--session") ?? "";
  const effect = verbEffect(call, read);
  if (read.options.has("--namespace")) {
    const lands: PageEffect = effect.does === "open" ? { does: "move" } : effect;
    return [
      { does: "move", session },
      { session, ...lands },
    ];
  }
  const verb: BrowserStep = { session, ...effect };
  return reconnects(read.options) ? [{ does: "move", session }, verb] : [verb];
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:/iu.test(url) ? url : `https://${url}`).host || null;
  } catch {
    return null;
  }
};

/**
 * A browser session's page as the browser shows it: the top page's URL, and a URL
 * for each frame found under it, null for one whose origin keeps it from the read.
 * A frame the page's script cannot reach is named, once loaded, by the URL it first
 * asked for; one inside it is not named.
 */
interface BrowserPage {
  url: string;
  frames: readonly (string | null)[];
}

/** Where a browser session is right now; null when nothing could say. "" is the default session. */
export type LivePage = (session: string) => Promise<BrowserPage | null>;

/** A URL's origin, or null for one no other URL shares (file:, data:, about:). */
const originOf = (url: string): string | null => {
  const origin = URL.parse(url)?.origin;
  return origin === undefined || origin === "null" ? null : origin;
};

/**
 * Where an act on a live page lands, or null when nobody could say. A ref from
 * `snapshot`, a `frame` switch or `webmcp --frame` acts inside a frame while the
 * URL stays the top page's, so the team's own build holding a frame of any other
 * origin, another localhost port included, is a page nobody could read: only a
 * frame of the top page's origin, or an about: one, counts as its. Elsewhere the
 * act waits on the site anyway.
 */
const landing = (page: BrowserPage | null): string | null => {
  if (page === null) {
    return null;
  }
  if (!onLoopback(page.url)) {
    return page.url;
  }
  const origin = originOf(page.url);
  const own = (frame: string | null): boolean =>
    frame !== null &&
    (frame.startsWith("about:") || (origin !== null && originOf(frame) === origin));
  return page.frames.every(own) ? page.url : null;
};

const unseen = (command: string): Hold => ({
  key: command,
  leasable: false,
  rule: "browser-unseen",
});

/** What acting on the page at `url` waits on, or null when it may run. A null `url` is a page nobody knows. */
const actHold = (url: string | null, leases: ReadonlySet<string>, command: string): Hold | null => {
  if (onLoopback(url)) {
    return null;
  }
  const host = url === null ? null : hostOf(url);
  if (host === null) {
    return unseen(command);
  }
  const key = `agent-browser: act on ${host}`;
  return leases.has(key) ? null : { key, leasable: true, rule: "browser-act" };
};

/**
 * The approval a browser command needs and does not have, or null when it may run.
 * Each step's verb is read where agent-browser reads it, and only a listed read
 * goes free. A command names a verb, never a site, so the site comes from the
 * browser itself: a click on the team's own localhost build can land anywhere,
 * and only the live page knows. That page is read before the command runs, so any
 * act after a step that may have moved the page lands somewhere nobody could read.
 * An `open` earlier in the same chained command names the site a remote act waits
 * on, but opening the team's build names only its top page: its frames are unread.
 */
const heldBrowserAct = async (
  line: string,
  key: string,
  leases: ReadonlySet<string>,
  livePage: LivePage,
): Promise<Hold | null> => {
  // Per session, where the page will be when the next step runs: absent is where the live page says, null is anywhere.
  const pages = new Map<string, string | null>();
  const land = (session: string, url: string | null): void => {
    pages.set(session, url);
    const alias = SESSION_ALIASES.get(session);
    if (alias !== undefined) {
      pages.set(alias, null);
    }
  };
  const calls = pipelinesOf(line)
    .pipelines.flat()
    .filter((call) => call.program === "agent-browser");
  for (const step of calls.flatMap(browserSteps)) {
    switch (step.does) {
      case "blind": {
        return unseen(key);
      }
      case "read": {
        break;
      }
      case "open": {
        land(step.session, onLoopback(step.url) ? null : step.url);
        break;
      }
      case "move": {
        land(step.session, null);
        break;
      }
      case "act": {
        const known = pages.get(step.session);
        const url = known === undefined ? landing(await livePage(step.session)) : known;
        const held = actHold(url, leases, key);
        if (held !== null) {
          return held;
        }
        if (step.moves) {
          land(step.session, null);
        } else {
          pages.set(step.session, url);
        }
        break;
      }
      // no default
    }
  }
  return null;
};

/** True when every internet target named is the game's own loopback API. */
const onlyLoopbackTargets = (command: string): boolean => {
  const urls = command.match(/https?:\/\/[^\s"'`)]+/gu) ?? [];
  const remote = urls.filter((u) => !LOOPBACK_URL.test(u));
  if (remote.length > 0) {
    return false;
  }
  return urls.length > 0 || command.includes("$IDLEBIZ_API_URL");
};

export type CommandVerdict = { decision: "allow" } | { decision: "ask"; rule: Rule };

export const classifyCommand = (command: string): CommandVerdict => {
  const { pipelines } = pipelinesOf(command);
  for (const rule of RULES) {
    if (!pipelines.some((pipeline) => rule.holds(pipeline))) {
      continue;
    }
    if (rule.networked && onlyLoopbackTargets(command)) {
      continue;
    }
    return { decision: "ask", rule };
  }
  return { decision: "allow" };
};

/** Remove CLI reporting suffixes and normalize the key used to reuse founder approvals. */
export const normalizeCommand = (command: string): string =>
  command
    .replaceAll(/\s*2>&1/gu, "")
    .replace(/\s*;\s*echo\s+["']?exit=\$\?["']?\s*$/u, "")
    .trim()
    .replaceAll(/\s+/gu, " ");

/** What a tool call waits on: the approval the founder signs, and whether signing covers the rest of the run. */
export interface Hold {
  /** The approval key, and the text on the founder's card. */
  key: string;
  rule: HoldRuleId;
  leasable: boolean;
}

/** Where a run may write without asking. Absolute paths. */
export interface Confinement {
  /** The run's working directory: a relative path is read from here. */
  cwd: string;
  /** Its cwd and every directory the run was granted. */
  writable: readonly string[];
  /** The save root: tasks, bets, approvals and instructions IdleBiz reads back as the company's truth. */
  save: string;
}

/** A path as the OS reads it from `cwd`, POSIX since the app ships for macOS only. `~` stays as named: no root is under a home this cannot see. */
const resolvePath = (cwd: string, file: string): string => {
  if (file === "~" || file.startsWith("~/")) {
    return file;
  }
  const parts: string[] = [];
  for (const part of (file.startsWith("/") ? file : `${cwd}/${file}`).split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== "" && part !== ".") {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
};

const within = (file: string, root: string): boolean =>
  file === root || file.startsWith(`${root}/`);

/** One line, so the key reads back the same from the task's saved ask. */
const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const editHold = (paths: readonly string[], room: Confinement): Hold | null => {
  const files = paths.map((file) => resolvePath(room.cwd, file));
  const loose = files.filter((file) => !room.writable.some((root) => within(file, root)));
  if (loose.length === 0) {
    return null;
  }
  return {
    key: oneLine(`edit: ${files.join(", ")}`),
    leasable: false,
    rule: loose.some((file) => within(file, room.save)) ? "save-edit" : "write-outside",
  };
};

/**
 * codex asks for a patch only when it reaches past its writable roots (or into a
 * path it protects inside them, like .git), so its ask is held whatever it names:
 * the files listed may all be the run's own while a move takes one into the save.
 */
const patchHold = (sources: readonly string[], room: Confinement): Hold => {
  const files = sources.map((file) => resolvePath(room.cwd, file));
  return {
    key: oneLine(`edit: ${[...files, "a file the ask does not name"].join(", ")}`),
    leasable: false,
    rule: editHold(sources, room)?.rule ?? "write-outside",
  };
};

/**
 * The one judgement every tool call passes through; null lets it run. `leases` is
 * what this run was already signed for, `confinement` where it may write.
 */
export const holdFor = async (
  tool: ToolAsk,
  leases: ReadonlySet<string>,
  livePage: LivePage,
  confinement: Confinement,
): Promise<Hold | null> => {
  if (tool.kind === "mcp") {
    // a server nothing can name is signed for call by call: a lease on "unknown" would cover every such server
    const key = `mcp: use ${tool.server ?? "a tool nothing could name"}`;
    return leases.has(key) ? null : { key, leasable: tool.server !== null, rule: "external-tool" };
  }
  if (tool.kind === "sandbox") {
    const reach = [...(tool.network ? ["network"] : []), ...tool.paths].join(", ");
    return {
      key: `sandbox: widen to ${reach || "more access"}`,
      leasable: false,
      rule: "sandbox-widen",
    };
  }
  if (tool.kind === "edit") {
    return editHold(tool.paths, confinement);
  }
  if (tool.kind === "patch") {
    return patchHold(tool.sources, confinement);
  }
  if (tool.kind === "network") {
    // the command behind it goes unseen, so nothing tells a read from a send
    const key = `network: reach ${tool.host ?? "a host nobody named"}`;
    return { key, leasable: false, rule: "http-write" };
  }
  if (tool.kind === "fetch") {
    // a read, as a bare `curl <url>` is: the shell rules hold only what sends
    return null;
  }
  if (tool.kind === "unknown") {
    const key = oneLine(`ask: ${tool.title || "a tool call nothing named"}`);
    return { key, leasable: false, rule: "unknown-ask" };
  }
  // Judged as sent: normalizing folds the newlines that separate commands into spaces.
  const key = normalizeCommand(tool.command);
  const verdict = classifyCommand(tool.command);
  if (verdict.decision === "ask") {
    return { key, leasable: false, rule: verdict.rule.id };
  }
  return await heldBrowserAct(tool.command, key, leases, livePage);
};
