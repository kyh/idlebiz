import type { HoldRuleId } from "@repo/domain/hold-rules";
import { lexLine } from "./shell-lexer";
import type { Words } from "./shell-lexer";
import {
  PACKAGE_MANAGERS,
  argumentsOf,
  exact,
  gnu,
  leadingOptions,
  pflag,
  wordsOf,
} from "./reading";
import type { Call, Flag, Grammar } from "./reading";

// Persist rule ids so approval cards can explain them.
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
] as const satisfies readonly HoldRuleId[];
export type RuleId = (typeof RULE_IDS)[number];

export interface Rule {
  id: RuleId;
  /** Whether a pipeline runs something this rule holds. */
  holds: (pipeline: readonly Call[]) => boolean;
}

const anyCall =
  (test: (call: Call) => boolean) =>
  (pipeline: readonly Call[]): boolean =>
    pipeline.some(test);

const DEPLOY_TOOLS = wordsOf("cf cloudflare fly netlify railway surge vercel wrangler");

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
    --body-data --body-file --config --directory-prefix --execute --header --input-file --method
    --output-document --output-file --password --post-data --post-file --referer --tries
    --timeout --user --user-agent --wait
  `),
  methods: new Set(["--method"]),
};

const FETCHERS = new Map([
  ["curl", CURL],
  ["wget", WGET],
]);

const sends = (args: Words, sending: Sending): boolean =>
  argumentsOf(args, sending.grammar).flags.some(
    (flag) =>
      sending.bodies.has(flag.name) ||
      (sending.methods.has(flag.name) && WRITE_METHODS.has(flag.value?.toUpperCase() ?? "")),
  );

const COPIERS = new Set(["rsync", "scp"]);
const REMOTE_PATH = /^[\w.-]+@[\w.-]+:/u;
const REMOTE_LOGIN = /^[\w.-]+@[\w.-]+/u;

const INTERPRETERS = wordsOf("bash dash python python3 sh zsh");

/** A path argument that leaves the workspace behind. */
const ESCAPES = String.raw`(?:~|\$(?:HOME\b|\{HOME\})|/(?:Users|home|etc|var|opt|System)\b|/Library\b)`;
const CREDENTIALS = new RegExp(String.raw`${ESCAPES}/\.(?:ssh|aws|gnupg|config/gh|netrc)\b`, "u");

const CREDENTIAL_READERS = wordsOf("base64 cat cp grep head less more openssl strings tail");
const KEYCHAIN_READS = new Set(["find-generic-password", "find-internet-password"]);

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
    // Every write asks, to a loopback port too: no fetch reaches the company, which a run calls
    // as `idlebiz <tool>`, and what listens there may be anyone's (a dev server, a debugger).
    holds: anyCall((call) => {
      const sending = FETCHERS.get(call.program);
      return sending !== undefined && sends(call.args, sending);
    }),
    id: "http-write",
  },
  {
    holds: anyCall(
      (call) =>
        (COPIERS.has(call.program) && call.args.some((arg) => REMOTE_PATH.test(arg))) ||
        (call.program === "ssh" && call.args.some((arg) => REMOTE_LOGIN.test(arg))),
    ),
    id: "remote-copy",
  },
  {
    holds: (pipeline) => {
      const fetched = pipeline.findIndex((call) => FETCHERS.has(call.program));
      return (
        fetched !== -1 && pipeline.slice(fetched + 1).some((call) => INTERPRETERS.has(call.program))
      );
    },
    id: "pipe-to-shell",
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
];

/** Every program whose words a rule reads. A rule reading another names it here too, or a line shells read apart can hand that program a word unseen. */
export const RULE_PROGRAMS = new Set([
  ...DEPLOY_TOOLS,
  ...PACKAGE_MANAGERS.keys(),
  ...COPIERS,
  ...CREDENTIAL_READERS,
  ...FETCHERS.keys(),
  "gh",
  "git",
  "security",
  "ssh",
  "stripe",
]);

/** The first rule something in `pipelines` runs is held under, or undefined when none holds. */
export const ruleHolding = (pipelines: readonly (readonly Call[])[]): Rule | undefined =>
  RULES.find((rule) => pipelines.some((pipeline) => rule.holds(pipeline)));
