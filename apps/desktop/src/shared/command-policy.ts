import type { ToolAsk } from "@repo/agent-driver/tool-ask";
import { lexFlat, lexLine } from "./shell-lexer";
import type { Command, Words } from "./shell-lexer";

// Applied to ACP permission requests from both runners. Unmatched commands run;
// the CLIs' own safeguards still apply. Persist rule ids so approval cards can explain them.
// A command line is split as bash would split it and seen through every wrapper that
// runs another command, so a rule reads a program's own words and never the text of
// a quoted argument. Heredoc text is data unless a shell or `source` reads it, or a
// substitution may print it as a command's name. What a script runs stays unseen:
// `npm run deploy` or a script on disk goes through.
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
] as const;
export type RuleId = (typeof RULE_IDS)[number];

interface CommandRule {
  id: RuleId | "browser-act" | "browser-unseen" | "external-tool" | "sandbox-widen";
  /** Shown on the approval card — what the founder is being asked to allow. */
  describe: string;
}

/** A program as invoked: its name without a path, every word after it, and what its command's redirections name. */
interface Call {
  program: string;
  args: Words;
  redirects: Words;
}

interface Rule extends CommandRule {
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
}

/** A vocabulary written as words separated by whitespace, as a man page lists them. */
const wordsOf = (text: string): ReadonlySet<string> =>
  new Set(text.split(/\s+/u).filter((word) => word !== ""));

const gnu = (valued: string): Grammar => ({ abbreviates: true, valued: wordsOf(valued) });
const exact = (valued = ""): Grammar => ({ abbreviates: false, valued: wordsOf(valued) });

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

/** A short cluster ends at its first option that takes a value (`-sXPOST`); `--name=value` carries its own. */
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
    if (grammar.valued.has(name)) {
      const attached = word.slice(at + 1);
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

/** Every option a program is given, wherever it sits among its operands, as pflag and curl read them (`gh api path -f x`). */
const allOptions = (args: Words, grammar: Grammar): Flag[] => {
  const flags: Flag[] = [];
  let at = 0;
  while (at < args.length && args[at] !== "--") {
    const word = args[at] ?? "";
    const taken = isOption(word) ? optionsIn(word, grammar, args[at + 1]) : null;
    flags.push(...(taken?.flags ?? []));
    at += taken?.next === true ? 2 : 1;
  }
  return flags;
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
  script: lastValue(allOptions(words.slice(from), SCRIPT), COMMAND_SCRIPT),
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
  script: lastValue(allOptions(words.slice(from), SU), SU_SCRIPT),
});

const WATCH = gnu("-n -q --equexit --interval");

/** watch hands its operands to `sh -c` joined by spaces, or with `-x` runs them as they are. */
const watchRuns = (words: Words, from: number): Runs => {
  const { end } = leadingOptions(words, from, WATCH);
  return { next: [end], script: words.slice(end).join(" ") };
};

/** Programs with a way of their own to name what they run. */
const RUNS_OWN = new Map<string, (words: Words, from: number) => Runs>([
  ["command", commandRuns],
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
      at += [...word].filter((char) => char === "o" || char === "O").length;
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
    return own(words, from);
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
const PASS_THROUGH = new Set([...WRAPPERS.keys(), ...RUNNERS, "command", "env", "eval"]);

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/u;
/** Words that open or close a compound command; the command after one still runs. `function` also takes a name. */
const RESERVED = wordsOf("! { } do done elif else esac fi function if then until while");
/** A word eval would read back as itself, so a line of them needs no second reading. */
const PLAIN = /^[^\s'"\\`$;&|<>()#]*$/u;
/** A name bash only knows once it expands it: `$(cat <<EOF … EOF)` runs whatever the substitution prints. */
const EXPANDED = /[$`]/u;
/** `npx vercel@latest` runs vercel; a leading `@` is a package scope. */
const PACKAGE_VERSION = /(?!^)@[^@/]*$/u;

const programOf = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1).replace(PACKAGE_VERSION, "");

/** A simple command's calls, each wrapper seen through to what it runs, and the scripts it hands a shell. */
interface Stage {
  calls: Call[];
  scripts: string[];
  /** A shell given no script reads one from its input: `bash <<EOF`, `cat <<EOF | sh`, and so does `source`. */
  readsInput: boolean;
  /** Its name comes from an expansion, so what its substitutions were fed may be what runs. */
  runsPrinted: boolean;
}

const stageOf = ({ words, redirects }: Command): Stage => {
  const stage: Stage = { calls: [], readsInput: false, runsPrinted: false, scripts: [] };
  if (words.length === 0) {
    // Redirections alone still open their files for what runs there: `(cat) < ~/.ssh/id_rsa | …`.
    stage.calls.push({ args: [], program: "", redirects });
  }
  const plain = words.every((word) => PLAIN.test(word));
  // Every command a wrapper runs starts after it, so one pass in order meets each start after whatever named it.
  const starts = new Set([0]);
  let managed = false;
  for (let from = 0; from < words.length; from += 1) {
    if (!starts.has(from)) {
      continue;
    }
    let start = from;
    while (ASSIGNMENT.test(words[start] ?? "") || RESERVED.has(words[start] ?? "")) {
      start += words[start] === "function" ? 2 : 1;
    }
    const head = words[start];
    if (head === undefined) {
      continue;
    }
    const program = programOf(head);
    // A package manager run by another is already among its words, which are all the publish rule reads.
    const repeated = managed && PACKAGE_MANAGERS.has(program);
    if (!PASS_THROUGH.has(program) && !repeated) {
      stage.calls.push({ args: words.slice(start + 1), program, redirects });
    }
    managed ||= PACKAGE_MANAGERS.has(program);
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

/** Past this many scripts inside scripts, which heredocs can nest without escaping, a script is read flat. */
const MAX_SCRIPT_DEPTH = 8;

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
 * `fedTexts` holds each such text already read and whether it reads its own
 * input: substitutions nest, so one heredoc reaches a command at every level,
 * and reading it at each would multiply the work by every level it passes.
 */
const pipelinesOf = (line: string, depth = 0, fedTexts = new Map<string, boolean>()): Reading => {
  if (depth > MAX_SCRIPT_DEPTH) {
    return {
      pipelines: lexFlat(line).map((pipeline) =>
        pipeline.flatMap((command) => stageOf(command).calls),
      ),
      reads: true,
    };
  }
  const readFed = (text: string): Reading => {
    const known = fedTexts.get(text);
    if (known !== undefined) {
      return { pipelines: [], reads: known };
    }
    // Until read, a text that meets itself again is taken to read its input.
    fedTexts.set(text, true);
    const reading = pipelinesOf(text, depth + 1, fedTexts);
    fedTexts.set(text, reading.reads);
    return reading;
  };
  let reads = false;
  const pipelines = lexLine(line).flatMap((pipeline) => {
    const stages = pipeline.map((command) => stageOf(command));
    const scripts = stages
      .flatMap((stage) => stage.scripts)
      .map((script) => pipelinesOf(script, depth + 1, fedTexts));
    const fed = stages.some((stage) => stage.readsInput) || scripts.some((script) => script.reads);
    const texts = pipeline.flatMap((command, index) => [
      ...(fed ? command.input : []),
      ...(fed || stages[index]?.runsPrinted === true ? command.printed.flat() : []),
    ]);
    const fedReadings = texts.map(readFed);
    reads ||=
      fed ||
      stages.some((stage) => stage.runsPrinted) ||
      fedReadings.some((reading) => reading.reads);
    return [
      stages.flatMap((stage) => stage.calls),
      ...scripts.flatMap((script) => script.pipelines),
      ...fedReadings.flatMap((reading) => reading.pipelines),
    ];
  });
  return { pipelines, reads };
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
const GIT = exact("-C -c --config-env --git-dir --namespace --super-prefix --work-tree");

/** gh verbs that only read — every other verb changes something on GitHub. */
const GITHUB_READS = wordsOf(
  "--help -h checkout checks clone co diff download list ls status view watch",
);

/** gh commands whose next word is no verb on GitHub; `api` is judged by its flags instead. */
const GITHUB_ASIDE = wordsOf("api auth browse completion config help search status version");

const GITHUB_API = exact(`
  -f -F -H -p -q -t -X --cache --field --header --hostname --input --jq --method
  --preview --raw-field --template
`);
const GITHUB_API_FIELDS = wordsOf("-f -F --field --input --raw-field");

/** `gh api` sends a POST once it has a field, so only an explicit GET keeps it a read; pflag keeps the last method given. */
const apiWrites = (args: Words): boolean => {
  const flags = allOptions(args, GITHUB_API);
  const method = flags.findLast((flag) => flag.name === "-X" || flag.name === "--method")?.value;
  if (method === undefined) {
    return flags.some((flag) => GITHUB_API_FIELDS.has(flag.name));
  }
  return method.toUpperCase() !== "GET";
};

const changesGitHub = (args: Words): boolean => {
  const [group, verb] = args;
  if (group === "api") {
    return apiWrites(args.slice(1));
  }
  return (
    group !== undefined &&
    !group.startsWith("-") &&
    !GITHUB_ASIDE.has(group) &&
    verb !== undefined &&
    !GITHUB_READS.has(verb)
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
  allOptions(args, sending.grammar).some(
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
    describe: "Deploy the product to a live, public URL.",
    // Bare `vercel` deploys; exclude read-only subcommands rather than listing deploy verbs.
    holds: anyCall(
      (call) => DEPLOY_TOOLS.has(call.program) && !DEPLOY_TOOL_READS.has(call.args[0] ?? ""),
    ),
    id: "deploy",
  },
  {
    describe: "Publish a package to a public registry.",
    holds: anyCall(
      (call) => PACKAGE_MANAGERS.has(call.program) && call.args.some((arg) => PUBLISHES.has(arg)),
    ),
    id: "publish-package",
  },
  {
    describe: "Push commits to a remote repository.",
    holds: anyCall(
      (call) =>
        call.program === "git" && call.args[leadingOptions(call.args, 0, GIT).end] === "push",
    ),
    id: "git-push",
  },
  {
    describe: "Change something on GitHub — open, merge, comment on, edit or release.",
    // Exclude read-only verbs rather than listing writes.
    holds: anyCall((call) => call.program === "gh" && changesGitHub(call.args)),
    id: "github-create",
  },
  {
    describe: "Move real money or change records in your Stripe account.",
    holds: anyCall(
      (call) => call.program === "stripe" && call.args.some((arg) => STRIPE_WRITES.has(arg)),
    ),
    id: "payments",
  },
  {
    describe: "Send data to a service on the internet.",
    holds: anyCall(
      (call) =>
        (call.program === "curl" && sends(call.args, CURL)) ||
        (call.program === "wget" && sends(call.args, WGET)),
    ),
    id: "http-write",
    networked: true,
  },
  {
    describe: "Copy files to another machine over the network.",
    holds: anyCall(
      (call) =>
        (COPIERS.has(call.program) && call.args.some((arg) => REMOTE_PATH.test(arg))) ||
        (call.program === "ssh" && call.args.some((arg) => REMOTE_LOGIN.test(arg))),
    ),
    id: "remote-copy",
    networked: true,
  },
  {
    describe: "Download code from the internet and run it immediately.",
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
    describe: "Read your stored credentials.",
    holds: anyCall(
      (call) =>
        (CREDENTIAL_READERS.has(call.program) && call.args.some((arg) => CREDENTIALS.test(arg))) ||
        // A redirection hands the file to whatever runs: `curl -d @- … < ~/.ssh/id_rsa`.
        call.redirects.some((target) => CREDENTIALS.test(target)) ||
        (call.program === "security" && KEYCHAIN_READS.has(call.args[0] ?? "")),
    ),
    id: "read-credentials",
  },
  {
    describe: "Irreversibly delete or overwrite files outside the workspace.",
    holds: anyCall(
      (call) => DELETERS.has(call.program) && call.args.some((arg) => OUTSIDE.test(arg)),
    ),
    id: "destructive-outside",
  },
  {
    describe: "Change files or permissions outside the workspace.",
    holds: anyCall(
      (call) =>
        (WRITERS.has(call.program) && call.args.some((arg) => NAMES_OUTSIDE.test(arg))) ||
        (call.program === "dd" &&
          call.args.some((arg) => arg.startsWith("of=") && NAMES_OUTSIDE.test(arg))),
    ),
    id: "write-outside",
  },
];

/** Approvals that cover the rest of a run rather than one command: what the founder signs is the site or the server, not the keystroke. */
const LEASE_RULES = [
  {
    describe:
      "Act in a real browser on this site — log in, type, click, submit — for the rest of this run.",
    id: "browser-act",
  },
  // Employee sessions load the founder's own CLI settings, so every MCP server
  // the founder connected for themselves — a browser, a mailbox, a chat
  // workspace — is in the employee's hands too, already signed in.
  {
    describe:
      "Use a tool connected in your own CLI settings (an MCP server, signed in as you) for the rest of this run.",
    id: "external-tool",
  },
] as const satisfies readonly CommandRule[];

/** Signed for like a shell command, once and exactly: no site can be named, so there is nothing to lease. */
const BROWSER_UNSEEN_RULE = {
  describe:
    "Act in a real browser on a page nobody could check first — one run of exactly this command.",
  id: "browser-unseen",
} as const satisfies CommandRule;

/** Signed for once and exactly, never leased: a widened sandbox already lets every later command in the run skip asking. */
const SANDBOX_RULE = {
  describe:
    "Let this run reach the internet or write outside its workspace without asking again, for every command until the run ends.",
  id: "sandbox-widen",
} as const satisfies CommandRule;

const LOOPBACK_HOST = String.raw`https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)`;
const LOOPBACK_URL = new RegExp(`^(?:${LOOPBACK_HOST}|file:|about:)`, "u");

const verbs = (names: readonly string[]): RegExp =>
  new RegExp(String.raw`(?:^|\s)(?:${names.join("|")})(?:\s|$)`, "u");

/** Acts that set a value and leave the page where it was. */
const SETS = ["fill", "type", "check", "uncheck", "upload"];
/** Acts that can take the page anywhere: a click or a key press goes wherever the site sends it. */
const LEAVES = [
  "click",
  "dblclick",
  "press",
  "key",
  "keydown",
  "keyup",
  "keyboard",
  "select",
  "drag",
  "eval",
  "find",
  "mouse",
  "download",
  String.raw`dialog\s+accept`,
  String.raw`webmcp\s+invoke`,
];
/** Reads that change which page the next step acts on. */
const NAVIGATES = [
  "back",
  "forward",
  "tab",
  "window",
  "frame",
  "pushstate",
  "connect",
  "a11y",
  "vitals",
  "record",
  "diff",
];

/** Verbs that change a page. Reading — open, read, snapshot, get, screenshot, scroll, wait — stays free. */
const BROWSER_WRITES = verbs([...SETS, ...LEAVES]);
/** Verbs after which nothing in the command says where the page is. */
const BROWSER_MOVES = verbs([...LEAVES, ...NAVIGATES]);
/** Verbs whose steps the command does not show: an AI at the wheel, a batch (its steps can be strings, JSON or stdin), a saved login's own page. */
const BROWSER_BLIND = verbs(["batch", "chat", "mcp", String.raw`auth\s+login`]);
const BROWSER_OPEN = /(?:^|\s)(?:open|goto|navigate)\s+(?<url>\S+)/u;

const hostOf = (url: string): string | null => {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:/iu.test(url) ? url : `https://${url}`).host || null;
  } catch {
    return null;
  }
};

/** Where a browser session is right now; null when nothing could say. "" is the default session. */
export type LiveUrl = (session: string) => Promise<string | null>;

const unseen = (command: string): Hold => ({
  key: command,
  leasable: false,
  rule: BROWSER_UNSEEN_RULE.id,
});

/** What acting on the page at `url` waits on, or null when it may run. A null `url` is a page nobody knows. */
const actHold = (url: string | null, leases: ReadonlySet<string>, command: string): Hold | null => {
  if (url !== null && LOOPBACK_URL.test(url)) {
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
 * A command names a verb, never a site, so the site comes from the browser
 * itself: a click on the team's own localhost build can land anywhere, and only
 * the live URL knows. That URL is read before the command runs, so an `open`
 * earlier in the same chained command wins, and any act after a step that may
 * have moved the page lands somewhere nobody could read.
 */
const heldBrowserAct = async (
  line: string,
  key: string,
  leases: ReadonlySet<string>,
  liveUrl: LiveUrl,
): Promise<Hold | null> => {
  // Per session, where the page will be when the next step runs: absent is where the live URL says, null is anywhere.
  const pages = new Map<string, string | null>();
  for (const call of pipelinesOf(line).pipelines.flat()) {
    if (call.program !== "agent-browser") {
      continue;
    }
    const args = call.args.join(" ");
    if (BROWSER_BLIND.test(args)) {
      return unseen(key);
    }
    const session = /--session[=\s]+(?<name>\S+)/u.exec(args)?.groups?.name ?? "";
    const opened = BROWSER_OPEN.exec(args)?.groups?.url;
    if (!BROWSER_WRITES.test(args)) {
      if (opened !== undefined) {
        pages.set(session, opened);
      } else if (BROWSER_MOVES.test(args)) {
        pages.set(session, null);
      }
      continue;
    }
    const known = pages.get(session);
    const url = known === undefined ? await liveUrl(session) : known;
    const held = actHold(url, leases, key);
    if (held !== null) {
      return held;
    }
    // A write whose text also names a verb that moves or opens is read as having moved.
    pages.set(session, opened === undefined && !BROWSER_MOVES.test(args) ? url : null);
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

export type CommandVerdict = { decision: "allow" } | { decision: "ask"; rule: CommandRule };

/** What the approval card says about a held command, by the rule that held it. */
export const describeRule = (id: string): string =>
  [...RULES, ...LEASE_RULES, BROWSER_UNSEEN_RULE, SANDBOX_RULE].find((rule) => rule.id === id)
    ?.describe ?? `Saved rule "${id}" is unavailable in this version.`;

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
  rule: CommandRule["id"];
  leasable: boolean;
}

/** The one judgement every tool call passes through; null lets it run. `leases` is what this run was already signed for. */
export const holdFor = async (
  tool: ToolAsk,
  leases: ReadonlySet<string>,
  liveUrl: LiveUrl,
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
      rule: SANDBOX_RULE.id,
    };
  }
  // Judged as sent: normalizing folds the newlines that separate commands into spaces.
  const key = normalizeCommand(tool.command);
  const verdict = classifyCommand(tool.command);
  if (verdict.decision === "ask") {
    return { key, leasable: false, rule: verdict.rule.id };
  }
  return await heldBrowserAct(tool.command, key, leases, liveUrl);
};
