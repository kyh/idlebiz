// Splits a command line the way bash does, so the command policy reads what would
// run instead of guessing at the text. Nothing is expanded: `$HOME` stays `$HOME`,
// and a substitution keeps its text in its word while its own commands are read
// as commands too. Each character is read a bounded number of times, so a long
// line cannot stall the caller.

/** Words with quotes and escapes resolved. */
export type Words = readonly string[];

/** One simple command, as bash would run it. */
export interface Command {
  words: Words;
  /** What its redirections name: files, or descriptors like the `1` of `2>&1`. */
  redirects: Words;
  /** The text its heredocs and here-strings feed it, as written. */
  input: Words;
  /** What the commands in its substitutions were fed, which they may print into its words: `$(cat <<EOF … EOF)`. */
  printed: readonly Words[];
  /**
   * Whether the shell passes its words on exactly as read here: none holds an
   * expansion, a substitution or a pattern bash or zsh fills in, and no `(`
   * zsh would take into a pattern stands among them (`-f (q)uery=m*`). Any such
   * word may become other words, or more of them, once the shell has run.
   */
  literal: boolean;
}

/** Simple commands joined by `|`, in the order data flows through them. */
export type Pipeline = readonly Command[];

/** Past this many nested substitutions, subshells and expansions the line is read flat instead of recursing. */
const MAX_DEPTH = 64;

/** What a flat reading takes for the start of a new command: a quote may open a script (`sh -c '…'`). */
const OPENERS = ["$(", "$'", '$"', "<(", ">(", "(", "`", "'", '"'];

/** Operators that end a command, longest first: all but a pipe also end its pipeline. */
const SEPARATORS = ["&&", "||", "|&", ";;&", ";;", ";&", ";|", "|", ";", "&", ")", "\n"];
const PIPES = new Set(["|", "|&"]);

/** Redirections: the word after one names a file, a descriptor or a heredoc's end, never an argument. */
const REDIRECTION = /&>>?|<<<|<<-?|[<>]&|<>|>>|>\||[<>]/uy;
const DESCRIPTOR = /^\d+$/u;
const LEADING_TABS = /^\t+/u;
const LINE_END = /\r$/u;
const FUNCTION_PARENS = /\([ \t]*\)/uy;
/** Text no reading treats specially, taken whole rather than a character at a time. */
const PLAIN_RUN = /[^\s$`<>'"\\|&;()]+/uy;
/**
 * Bare text the shell passes on as written: no glob, brace, tilde or history
 * character, nor one zsh's extended globs read. zsh also expands an `=` that
 * opens a word into a path (`=ls`), and a lone `{` or `}` is a reserved word.
 */
const VERBATIM = /^[\w%+,./:=@-]*$/u;

const verbatim = (run: string, opens: boolean): boolean =>
  opens
    ? run === "{" || run === "}" || (VERBATIM.test(run) && !run.startsWith("="))
    : VERBATIM.test(run);

/**
 * Shells disagree on where a substitution ends. Where a `case` opens decides
 * whether a `)` after it ends a pattern or the substitution: dash reads one where
 * POSIX takes a command's name, bash also after `time`, `coproc NAME` and
 * `function NAME`, zsh after forms only it has (`repeat 3 case`, `if [[ … ]] case`),
 * and bash 3.2 finds a substitution's end by its parentheses alone. dash also
 * reads any `$((` as arithmetic, where the others may read subshells. Reading a
 * line as one shell can carry the words after such a `)` into the substitution
 * another ends there, so a line they may read apart is read in every dialect.
 */
type Parser = "bash" | "posix" | "zsh";
type Dialect = Parser | "bash-3.2";
/** A strict reading follows a dialect; a flat one takes every opener for a command's start. */
type Reading = Dialect | "flat";

/** Where a command's next word stands: a `case` opens one only where the name may be. */
type Place =
  /** The name, or a reserved word leading it: `if case …`. */
  | "name"
  /** After bash's `time`, whose `-p` and `--` still come before the name. */
  | "time"
  /** After bash's `coproc`: the name, or the coprocess's NAME with the name after it. */
  | "coproc"
  /** A reserved word's operand, with the name after it: bash's `function NAME`, zsh's `repeat COUNT`. */
  | "operand"
  /** Past zsh's `function`, whose names run to its body's `{`: `function f case { … }`. */
  | "names"
  /** After `for`: `for ((…))` leads a name, `for NAME` does not. */
  | "for"
  /** Past a `}` closing a zsh group: `always` leads another, and a name may follow a condition's (`if { true } case`). */
  | "brace"
  /** Inside a zsh test, whose `]]` ends a condition a name may follow: `if [[ -n $x ]] case`. */
  | "test"
  /** Past a compound command's closing word, where only another may follow: `case … esac esac`. */
  | "closed"
  | "argument";

/** Where a name may be, so a `case` or `esac` there counts. */
const NAMED: ReadonlySet<Place> = new Set(["name", "time", "coproc", "brace"]);

/** Words closing a compound command, after which bash and dash still read `esac`: `case a in a) if …; fi esac`. */
const CLOSERS = ["done", "esac", "fi", "}"];

/** What every parser makes of the word after each of these, read where a name may be. */
const POSIX_LEADS: [string, Place][] = [
  ...["!", "{", "do", "elif", "else", "if", "then", "until", "while"].map(
    (word): [string, Place] => [word, "name"],
  ),
  ...CLOSERS.map((word): [string, Place] => [word, "closed"]),
  ["for", "for"],
];

/** What each parser's reserved words, read where the name may be, make of the word after them. */
const LEADS: Record<Parser, ReadonlyMap<string, Place>> = {
  bash: new Map([...POSIX_LEADS, ["coproc", "coproc"], ["function", "operand"], ["time", "time"]]),
  posix: new Map(POSIX_LEADS),
  zsh: new Map([
    ...POSIX_LEADS,
    ["[[", "test"],
    ["coproc", "name"],
    // A name may follow a condition's `esac`: `if case … esac git push`.
    ["esac", "name"],
    ["function", "names"],
    ["repeat", "operand"],
    ["time", "name"],
    ["}", "brace"],
  ]),
};

/** Arithmetic, which zsh's short forms run a command straight after: `while (( n-- )) case`. */
const ARITHMETIC = /^\(\(/u;
const TIME_OPTIONS = new Set(["-p", "--"]);
/** What ends a `case` item, after which the next word is a pattern: `case a in b) :;; case) …` opens nothing. */
const ITEM_ENDS = new Set([";;", ";;&", ";&", ";|"]);

const nameAt = (word: string, bare: boolean, parser: Parser): Place => {
  if (!bare) {
    return "argument";
  }
  if (parser === "zsh" && ARITHMETIC.test(word)) {
    return "name";
  }
  return LEADS[parser].get(word) ?? "argument";
};

/** What a word read at each place leaves the next one as. */
const STEPS: Record<Place, (word: string, bare: boolean, parser: Parser) => Place> = {
  argument: () => "argument",
  brace: (word, bare, parser) => (bare && word === "always" ? "name" : nameAt(word, bare, parser)),
  closed: (word, bare) => (bare && CLOSERS.includes(word) ? "closed" : "argument"),
  coproc: (word, bare, parser) => {
    const next = nameAt(word, bare, parser);
    return next === "argument" ? "name" : next;
  },
  for: (word, bare) => (bare && ARITHMETIC.test(word) ? "name" : "argument"),
  name: nameAt,
  names: (word, bare) => (bare && word === "{" ? "name" : "names"),
  operand: () => "name",
  test: (word, bare) => (bare && word === "]]" ? "name" : "test"),
  time: (word, bare, parser) =>
    bare && TIME_OPTIONS.has(word) ? "time" : nameAt(word, bare, parser),
};

/** The escapes bash drops from a backtick body before reading it, which is how `\`` nests one substitution in another. */
const BACKTICK_ESCAPE = /\\(?<escaped>[$\\`])/gu;

/** Inside double quotes a backslash escapes only these, and is kept before anything else. */
const ESCAPABLE_IN_QUOTES = new Set(["$", "`", '"', "\\", "\n"]);

/**
 * What a backslash names inside `$'…'`. Any other escaped character stands for
 * itself: bash would keep its backslash and zsh drops it, and without it the
 * word is the one that can run (`$'\push'` pushes under zsh).
 */
const ANSI_ESCAPES = new Map([
  ["a", "\u0007"],
  ["b", "\b"],
  ["e", "\u001B"],
  ["E", "\u001B"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
]);
/** Escapes by number: an octal or hex byte (`\101`, `\x41`), or a code point (`\u2014`, `\U0001F600`). */
const ANSI_NUMBER = /[0-7]{1,3}|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}/uy;
const HEX_PREFIXES = new Set(["x", "u", "U"]);
const LAST_CODE_POINT = 0x10_ff_ff;

const ansiNumber = (code: string): string => {
  const value = HEX_PREFIXES.has(code.charAt(0))
    ? Number.parseInt(code.slice(1), 16)
    : Number.parseInt(code, 8) % 0x1_00;
  return value > LAST_CODE_POINT ? "\uFFFD" : String.fromCodePoint(value);
};

/** A quoted string's text, and whether the shell still fills some of it in: `"$x"`. */
interface Quoted {
  text: string;
  expands: boolean;
}

/** What the word being read is for. */
type Target = "argument" | "redirect" | "here-string" | "heredoc" | "indented-heredoc";

const TARGETS = new Map<string, Target>([
  ["<<", "heredoc"],
  ["<<-", "indented-heredoc"],
  ["<<<", "here-string"],
]);

interface Heredoc {
  delimiter: string;
  /** `<<-` strips leading tabs, so its closing line may be indented. */
  indented: boolean;
  /** A quoted delimiter keeps the body literal; otherwise its substitutions run. */
  literal: boolean;
  /** The body arrives after its command has ended, so it goes straight into that command's input. */
  input: string[];
}

/**
 * A `case` reads its subject and `in` before its patterns, and a `)` ends those;
 * the list after runs commands. Past a zsh pattern's `( … )` it is `grouped`: a
 * `)` there ends the patterns, and anything else starts the list.
 */
type Clause = "commands" | "subject" | "in" | "patterns" | "grouped";

/** What a list has open: a `case`, zsh's `case a { … }`, a zsh group, or the `( … )` zsh reads whole in a pattern. */
type Open = "case" | "braced case" | "group" | "pattern group";

/** One command list being read: the top level, a subshell, or a substitution. */
interface Frame {
  pipeline: Command[];
  /** Whether a pipe has joined commands in this pipeline yet. */
  piped: boolean;
  /** A subshell's pipelines: one piped to or from a command joins its pipeline, all feeding the pipe (`(curl … || wget …) | sh`). */
  group: Pipeline[];
  words: string[];
  redirects: string[];
  input: string[];
  printed: Words[];
  /** What every command read in this list was fed, for the command whose substitution the list is. */
  fed: Words[];
  /** null between words, so `''` still makes a word. */
  word: string | null;
  quoted: boolean;
  /** Whether the word holds text the shell still fills in: `$x`, `*`, `"$(…)"`. */
  expands: boolean;
  /** Whether every word of the command so far reaches it as read. */
  literal: boolean;
  target: Target;
  /** Whether the command has a redirection, which makes it one even with no words: `(cat) <<EOF | sh`. */
  redirected: boolean;
  /** Where the command's next word stands, which says whether a `case` there opens one. */
  place: Place;
  /** What is open, innermost last: zsh's bare `}` closes a group or a braced `case` wherever it stands. */
  opens: Open[];
  /** How many of `opens` are a `case`: until none is, a `)` ends a pattern, not the list. */
  cases: number;
  /** Where the innermost open `case` is: its patterns run nothing, so a `case` among them opens nothing. */
  clause: Clause;
}

const append = (frame: Frame, text: string): void => {
  frame.word = (frame.word ?? "") + text;
};

const pushAll = <T>(into: T[], items: readonly T[]): void => {
  // Not a spread: a line can hold more items than a call takes arguments.
  for (const item of items) {
    into.push(item);
  }
};

/** Closes the innermost `case`, if nothing opened since is still open. */
const closeCase = (frame: Frame): void => {
  const open = frame.opens.at(-1);
  if (open === "case" || open === "braced case") {
    frame.opens.pop();
    frame.cases -= 1;
    frame.clause = "commands";
  }
};

/** What an open `case`'s subject, `in` and patterns make of the next word: among its patterns only its end means anything. */
const CASE_WORDS: Record<
  Exclude<Clause, "commands" | "grouped">,
  (frame: Frame, word: string, bare: boolean, parser: Parser) => void
> = {
  in: (frame, word, bare, parser) => {
    const braced = bare && parser === "zsh" && word === "{";
    if (braced) {
      frame.opens.pop();
      frame.opens.push("braced case");
    }
    frame.clause = braced || (bare && word === "in") ? "patterns" : "commands";
  },
  patterns: (frame, word, bare, parser) => {
    // zsh ends either kind of `case` with either word.
    if (bare && (word === "esac" || (parser === "zsh" && word === "}"))) {
      closeCase(frame);
      frame.place = nameAt(word, bare, parser);
    }
  },
  subject: (frame) => {
    frame.clause = "in";
  },
};

/** zsh's `}` among commands closes the innermost group, which a name may follow, or `case a { … }`. */
const closeBrace = (frame: Frame): boolean => {
  const open = frame.opens.at(-1);
  if (open === "group") {
    frame.opens.pop();
    frame.place = "brace";
  } else if (open === "braced case") {
    closeCase(frame);
    frame.place = "brace";
  }
  return open === "group" || open === "braced case";
};

/** Reads a word that belongs to what is open rather than to a command, and says whether it did. */
const readOpen = (frame: Frame, word: string, bare: boolean, parser: Parser): boolean => {
  if (frame.opens.at(-1) === "pattern group") {
    return true;
  }
  if (frame.clause === "grouped") {
    frame.clause = "commands";
  }
  if (frame.clause !== "commands") {
    CASE_WORDS[frame.clause](frame, word, bare, parser);
    return true;
  }
  return parser === "zsh" && bare && word === "}" && frame.place !== "test" && closeBrace(frame);
};

/**
 * Reads a command's word as a parser does: an unquoted `case` or `esac` where a
 * name may be opens or closes one (`echo case` opens nothing, `repeat 3 case`
 * does under zsh), and a pattern opens nothing.
 */
const readWord = (frame: Frame, word: string, bare: boolean, parser: Parser): void => {
  if (readOpen(frame, word, bare, parser)) {
    return;
  }
  const named = bare && NAMED.has(frame.place);
  if (named && word === "case") {
    frame.opens.push("case");
    frame.cases += 1;
    frame.clause = "subject";
  } else if (bare && word === "esac" && (named || frame.place === "closed")) {
    closeCase(frame);
  } else if (bare && word === "{" && parser === "zsh" && (named || frame.place === "names")) {
    frame.opens.push("group");
  }
  frame.place = STEPS[frame.place](word, bare, parser);
};

const joinGroup = (frame: Frame): void => {
  for (const pipeline of frame.group.splice(0)) {
    pushAll(frame.pipeline, pipeline);
  }
};

/**
 * Reads one line. A strict reading follows bash, save where its dialect reads a
 * `case`. A flat one takes every quote and opener for a command start, and every
 * heredoc or comment line for a line of commands, so it needs no recursion and
 * finds a command wherever one could start.
 */
class Scanner {
  readonly pipelines: Pipeline[] = [];
  /** A quote never closed (bash refuses the line) or nesting too deep to follow. */
  unreadable = false;
  /**
   * Whether a dialect may read the line apart from bash: it has an unquoted
   * `case`, or a `$((` bash reads as subshells, which dash reads as arithmetic.
   */
  divergent = false;
  private at = 0;
  private depth: number;
  private frame: Frame | null = null;
  private readonly pending: Heredoc[] = [];
  /** Where a `((` was read to its end and turned out to open subshells, so it is not taken for arithmetic again. */
  private readonly subshells = new Set<number>();
  private readonly text: string;
  private readonly reading: Reading;
  private readonly strict: boolean;

  constructor(text: string, reading: Reading, depth = 0) {
    this.text = text;
    this.reading = reading;
    this.strict = reading !== "flat";
    this.depth = depth;
  }

  /** Reads commands until `close` (a substitution's or subshell's end) or the end of the text, and returns what they were fed. */
  list(close: string | null): Words[] {
    const frame: Frame = {
      cases: 0,
      clause: "commands",
      expands: false,
      fed: [],
      group: [],
      input: [],
      literal: true,
      opens: [],
      piped: false,
      pipeline: [],
      place: "name",
      printed: [],
      quoted: false,
      redirected: false,
      redirects: [],
      target: "argument",
      word: null,
      words: [],
    };
    const outer = this.frame;
    this.frame = frame;
    while (this.at < this.text.length) {
      const char = this.text.charAt(this.at);
      if (char === ")") {
        // Before the `)` is judged: in `$(case … esac)` the `esac` closes its case first.
        this.endWord(frame);
      }
      if (char === close && (close !== ")" || frame.cases === 0)) {
        this.at += 1;
        break;
      }
      if (!this.operator(frame, char)) {
        this.wordPart(frame, char);
      }
    }
    this.endPipeline(frame);
    this.frame = outer;
    return frame.fed;
  }

  private operator(frame: Frame, char: string): boolean {
    // bash reads a carriage return as text (`true\r#` is a word, not a comment); only one ending a line is taken for a blank.
    if (char === " " || char === "\t" || (char === "\r" && this.endsLine(this.at + 1))) {
      this.endWord(frame);
      this.at += 1;
      return true;
    }
    if (char === "#" && frame.word === null && this.strict) {
      const newline = this.text.indexOf("\n", this.at);
      this.at = newline === -1 ? this.text.length : newline;
      return true;
    }
    const opener = this.strict ? undefined : OPENERS.find((o) => this.text.startsWith(o, this.at));
    if (opener !== undefined) {
      this.endPipeline(frame);
      this.at += opener.length;
      return true;
    }
    if (char === "(" && frame.clause === "patterns" && frame.word === null) {
      // A pattern may open with one: `case a in (b) …`. zsh reads to its `)` as pattern, spaces and all.
      if (this.reading === "zsh") {
        frame.opens.push("pattern group");
      }
      this.at += 1;
      return true;
    }
    if (char === "(") {
      this.parenthesis(frame);
      return true;
    }
    return this.redirection(frame) || this.separator(frame);
  }

  /** `((` may be arithmetic, `name()` defines a function whose body is the command after it, and any other `(` opens a subshell. */
  private parenthesis(frame: Frame): void {
    const doubled = frame.word === null && this.text.charAt(this.at + 1) === "(";
    const arithmetic = doubled ? this.arithmetic(2) : null;
    if (arithmetic !== null) {
      frame.expands = true;
      append(frame, arithmetic);
      return;
    }
    // Where bash reads no subshell, zsh reads a pattern: `query=m(u)tation*`, `-f (q)uery=m*`.
    const pattern = frame.word !== null || frame.place === "argument";
    this.endWord(frame);
    FUNCTION_PARENS.lastIndex = this.at;
    const [parens] = FUNCTION_PARENS.exec(this.text) ?? [];
    if (parens !== undefined && frame.words.length > 0) {
      // A definition runs nothing, so its name is no command: `vercel() { … }` deploys nothing.
      frame.words = [];
      frame.place = "name";
      this.at += parens.length;
      return;
    }
    frame.literal &&= !pattern;
    // What follows a subshell is a command of its own: `case a in (a) git push;; esac`.
    this.endCommand(frame);
    const before = this.pipelines.length;
    this.nested(1, ")");
    pushAll(frame.group, this.pipelines.splice(before));
  }

  private endsLine(at: number): boolean {
    return at >= this.text.length || this.text.charAt(at) === "\n";
  }

  private redirection(frame: Frame): boolean {
    if (this.text.startsWith("<(", this.at) || this.text.startsWith(">(", this.at)) {
      return false;
    }
    REDIRECTION.lastIndex = this.at;
    const [operator] = REDIRECTION.exec(this.text) ?? [];
    if (operator === undefined) {
      return false;
    }
    if (frame.word !== null && !frame.quoted && DESCRIPTOR.test(frame.word)) {
      frame.word = null;
    }
    this.endWord(frame);
    this.at += operator.length;
    frame.redirected = true;
    frame.target = (this.strict ? TARGETS.get(operator) : undefined) ?? "redirect";
    return true;
  }

  private separator(frame: Frame): boolean {
    const operator = SEPARATORS.find((candidate) => this.text.startsWith(candidate, this.at));
    if (operator === undefined) {
      return false;
    }
    this.at += operator.length;
    if (PIPES.has(operator)) {
      joinGroup(frame);
      this.endCommand(frame);
      frame.piped = true;
      if (frame.clause === "grouped") {
        frame.clause = "patterns";
      }
      return true;
    }
    // A pipe at the end of a line feeds the next line: `curl … |`, then `bash`.
    const piping = frame.pipeline.length > 0 && frame.words.length === 0 && frame.word === null;
    if (operator !== "\n" || !piping) {
      this.endPipeline(frame);
    }
    if (operator === ")" && frame.opens.at(-1) === "pattern group") {
      frame.opens.pop();
      frame.clause = frame.opens.at(-1) === "pattern group" ? "patterns" : "grouped";
    } else if (operator === ")" && (frame.clause === "patterns" || frame.clause === "grouped")) {
      frame.clause = "commands";
    } else if (ITEM_ENDS.has(operator) && frame.cases > 0) {
      frame.clause = "patterns";
    }
    if (operator === "\n") {
      this.heredocBodies();
    }
    return true;
  }

  private wordPart(frame: Frame, char: string): void {
    PLAIN_RUN.lastIndex = this.at;
    const [run] = PLAIN_RUN.exec(this.text) ?? [];
    if (run !== undefined) {
      frame.expands ||= !verbatim(run, frame.word === null);
      append(frame, run);
      this.at += run.length;
      return;
    }
    const substituted =
      this.expansion() ?? this.substitution(char) ?? this.processSubstitution(char);
    if (substituted !== null) {
      frame.expands = true;
      append(frame, substituted);
      return;
    }
    const quoted = this.quoted(char);
    if (quoted !== null) {
      frame.quoted = true;
      frame.expands ||= quoted.expands;
      append(frame, quoted.text);
    } else if (char === "\\") {
      this.escape(frame);
    } else {
      // A `$` that opens no quote or substitution (`$x`), or text no reading above took.
      frame.expands = true;
      append(frame, char);
      this.at += 1;
    }
  }

  /** A quoted string that starts here, with its quotes and escapes resolved. */
  private quoted(char: string): Quoted | null {
    const next = this.text.charAt(this.at + 1);
    if (char === "'") {
      return { expands: false, text: this.singleQuoted() };
    }
    if (char === '"') {
      return this.doubleQuoted();
    }
    if (char === "$" && next === "'") {
      return { expands: false, text: this.ansiQuoted() };
    }
    if (char === "$" && next === '"') {
      // A string for translation, which bash reads as double quotes and may swap for another.
      this.at += 1;
      return { expands: true, text: this.doubleQuoted().text };
    }
    return null;
  }

  /** `$( … )` and `` ` … ` `` run their own commands; the word keeps their text. `$((` is arithmetic unless it closes as `) )`. */
  private substitution(char: string): string | null {
    if (char === "`") {
      return this.backticks();
    }
    if (char !== "$" || this.text.charAt(this.at + 1) !== "(") {
      return null;
    }
    const arithmetic = this.text.charAt(this.at + 2) === "(" ? this.arithmetic(3) : null;
    return arithmetic ?? this.nested(2, ")");
  }

  /** `<( … )` and `>( … )`, which are literal text inside quotes. */
  private processSubstitution(char: string): string | null {
    const opens = (char === "<" || char === ">") && this.text.charAt(this.at + 1) === "(";
    return opens ? this.nested(2, ")") : null;
  }

  /** `${…}` and `$[…]` are one word to bash up to their close: `${x:- #}` holds no comment, `${x//<</}` no heredoc. */
  private expansion(): string | null {
    return this.enclosed("${", "}", false) ?? this.enclosed("$[", "]", true);
  }

  private enclosed(opener: string, close: string, nests: boolean): string | null {
    if (!this.strict || !this.text.startsWith(opener, this.at)) {
      return null;
    }
    const start = this.at;
    this.at += opener.length;
    if (this.descend()) {
      this.through(opener.charAt(1), close, nests);
      this.depth -= 1;
    }
    return this.text.slice(start, this.at);
  }

  /**
   * `((…))` and `$((…))` are arithmetic, one word to bash where `<<` shifts,
   * unless they close as `) )`: bash then reads them again as a subshell inside
   * a subshell or substitution, and so does this.
   */
  private arithmetic(opening: number): string | null {
    const start = this.at;
    if (!this.strict || this.subshells.has(start)) {
      return null;
    }
    if (this.reading === "posix" && opening === 3) {
      return this.dashArithmetic();
    }
    const before = {
      pending: [...this.pending],
      pipelines: this.pipelines.length,
      printed: this.frame?.printed.length ?? 0,
      unreadable: this.unreadable,
    };
    this.at += opening;
    if (!this.descend()) {
      return this.text.slice(start, this.at);
    }
    const closed = this.through("(", ")", true);
    this.depth -= 1;
    // Never closed, the line is read flat as well, so reading it again as commands would find nothing more.
    if (!closed || this.text.charAt(this.at) === ")") {
      this.at += closed ? 1 : 0;
      return this.text.slice(start, this.at);
    }
    this.subshells.add(start);
    this.divergent ||= opening === 3;
    this.at = start;
    this.pending.splice(0);
    pushAll(this.pending, before.pending);
    this.pipelines.splice(before.pipelines);
    this.frame?.printed.splice(before.printed);
    this.unreadable = before.unreadable;
    return null;
  }

  /** dash reads any `$((` as arithmetic, to the first `))` outside parentheses: a lone `)` is text to it. */
  private dashArithmetic(): string {
    const start = this.at;
    this.at += 3;
    if (this.descend()) {
      let closed = this.through("(", ")", true);
      while (closed && this.text.charAt(this.at) !== ")") {
        closed = this.through("(", ")", true);
      }
      this.at += closed ? 1 : 0;
      this.depth -= 1;
    }
    return this.text.slice(start, this.at);
  }

  /** Reads past the `close` that matches, counting nested `open`s: inside, only quotes, escapes, substitutions and expansions are more than text. */
  private through(open: string, close: string, nests: boolean): boolean {
    let opened = 0;
    while (this.at < this.text.length) {
      const char = this.text.charAt(this.at);
      if (char === close && opened === 0) {
        this.at += 1;
        return true;
      }
      if (char === close || (nests && char === open)) {
        opened += char === close ? -1 : 1;
        this.at += 1;
      } else if ((this.expansion() ?? this.substitution(char) ?? this.quoted(char)) === null) {
        this.at += char === "\\" ? 2 : 1;
      }
    }
    this.unreadable = true;
    return false;
  }

  /** A backtick body holding `\``, `\\` or `\$` is read again with those escapes dropped, as bash does. */
  private backticks(): string {
    const start = this.at;
    let end = start + 1;
    while (end < this.text.length && this.text.charAt(end) !== "`") {
      end += this.text.charAt(end) === "\\" ? 2 : 1;
    }
    const body = this.text.slice(start + 1, end);
    const unescaped = body.replaceAll(BACKTICK_ESCAPE, "$<escaped>");
    if (unescaped === body) {
      return this.nested(1, "`");
    }
    this.at = Math.min(end + 1, this.text.length);
    this.unreadable ||= end >= this.text.length;
    if (this.descend()) {
      const inner = new Scanner(unescaped, this.reading, this.depth);
      pushAll(this.frame?.printed ?? [], inner.list(null));
      pushAll(this.pipelines, inner.pipelines);
      this.unreadable ||= inner.unreadable;
      this.divergent ||= inner.divergent;
      this.depth -= 1;
    }
    return this.text.slice(start, this.at);
  }

  private nested(opening: number, close: string): string {
    const start = this.at;
    this.at += opening;
    if (this.descend()) {
      const fed = this.list(close);
      pushAll(this.frame?.printed ?? [], fed);
      this.depth -= 1;
    }
    return this.text.slice(start, this.at);
  }

  /** One level deeper, unless that is past what this follows: then the line is read flat as well. */
  private descend(): boolean {
    if (this.depth >= MAX_DEPTH) {
      this.unreadable = true;
      return false;
    }
    this.depth += 1;
    return true;
  }

  private escape(frame: Frame): void {
    const next = this.text.charAt(this.at + 1);
    this.at += 2;
    if (next !== "\n") {
      frame.quoted = true;
      append(frame, next);
    }
  }

  private singleQuoted(): string {
    const close = this.text.indexOf("'", this.at + 1);
    const end = close === -1 ? this.text.length : close;
    const text = this.text.slice(this.at + 1, end);
    this.unreadable ||= close === -1;
    this.at = end + 1;
    return text;
  }

  private doubleQuoted(): Quoted {
    let text = "";
    let expands = false;
    this.at += 1;
    while (this.at < this.text.length) {
      const char = this.text.charAt(this.at);
      if (char === '"') {
        this.at += 1;
        return { expands, text };
      }
      // quotedPart takes an escaped one with its backslash, so each seen here is live.
      expands ||= char === "$" || char === "`";
      text += this.quotedPart(char);
    }
    this.unreadable = true;
    return { expands, text };
  }

  /** Substitutions still run inside double quotes. */
  private quotedPart(char: string): string {
    const substituted = this.substitution(char);
    if (substituted !== null) {
      return substituted;
    }
    const next = this.text.charAt(this.at + 1);
    if (char === "\\" && ESCAPABLE_IN_QUOTES.has(next)) {
      this.at += 2;
      return next === "\n" ? "" : next;
    }
    this.at += 1;
    return char;
  }

  /** `$'…'`, where a backslash escapes any character: `\'` is a quote in the word, not its end. */
  private ansiQuoted(): string {
    let text = "";
    this.at += 2;
    // bash's string ends at a NUL, dropping what follows it inside the quotes.
    let ended = false;
    while (this.at < this.text.length) {
      const char = this.text.charAt(this.at);
      if (char === "'") {
        this.at += 1;
        return text;
      }
      const part = this.ansiPart(char);
      ended ||= part === "\0";
      if (!ended) {
        text += part;
      }
    }
    this.unreadable = true;
    return text;
  }

  private ansiPart(char: string): string {
    if (char !== "\\") {
      this.at += 1;
      return char;
    }
    ANSI_NUMBER.lastIndex = this.at + 1;
    const [code] = ANSI_NUMBER.exec(this.text) ?? [];
    if (code !== undefined) {
      this.at += 1 + code.length;
      return ansiNumber(code);
    }
    const next = this.text.charAt(this.at + 1);
    this.at += 2;
    return ANSI_ESCAPES.get(next) ?? next;
  }

  /** A heredoc's body starts on the line after its operator and is its command's input, save the substitutions of an unquoted one. */
  private heredocBodies(): void {
    // A body's substitutions print into the body, not into the command read next.
    const printed = this.frame?.printed.length ?? 0;
    for (const heredoc of this.pending.splice(0)) {
      const start = this.at;
      let end = start;
      while (end < this.text.length && !this.closes(heredoc, end)) {
        end = this.lineAfter(end);
      }
      heredoc.input.push(this.text.slice(start, end));
      if (!heredoc.literal) {
        this.substitutionsIn(start, end);
      }
      this.at = Math.max(this.at, this.lineAfter(end));
    }
    this.frame?.printed.splice(printed);
  }

  private closes(heredoc: Heredoc, start: number): boolean {
    const newline = this.text.indexOf("\n", start);
    const line = this.text.slice(start, newline === -1 ? this.text.length : newline);
    const bare = line.replace(LINE_END, "");
    return (heredoc.indented ? bare.replace(LEADING_TABS, "") : bare) === heredoc.delimiter;
  }

  private lineAfter(start: number): number {
    const newline = this.text.indexOf("\n", start);
    return newline === -1 ? this.text.length : newline + 1;
  }

  private substitutionsIn(start: number, end: number): void {
    this.at = start;
    while (this.at < end) {
      const char = this.text.charAt(this.at);
      if (char === "\\") {
        this.at += 2;
      } else if (this.substitution(char) === null) {
        this.at += 1;
      }
    }
  }

  private endWord(frame: Frame): void {
    if (frame.word === null) {
      return;
    }
    if (frame.target === "argument") {
      frame.literal &&= !frame.expands;
      const bare = !frame.quoted;
      this.divergent ||= bare && frame.word === "case";
      const { reading } = this;
      if (reading !== "flat" && reading !== "bash-3.2") {
        readWord(frame, frame.word, bare, reading);
      }
      frame.words.push(frame.word);
    } else if (frame.target === "redirect") {
      frame.redirects.push(frame.word);
    } else if (frame.target === "here-string") {
      frame.input.push(frame.word);
    } else {
      this.pending.push({
        delimiter: frame.word,
        indented: frame.target === "indented-heredoc",
        input: frame.input,
        literal: frame.quoted,
      });
    }
    frame.word = null;
    frame.quoted = false;
    frame.expands = false;
    frame.target = "argument";
  }

  private endCommand(frame: Frame): void {
    this.endWord(frame);
    if (frame.words.length > 0 || frame.redirected) {
      frame.pipeline.push({
        input: frame.input,
        // A flat reading splits words at every quote, so none of its commands is read as it runs.
        literal: frame.literal && this.strict,
        printed: frame.printed,
        redirects: frame.redirects,
        words: frame.words,
      });
      frame.fed.push(frame.input);
    }
    // A command can print what its own substitutions were fed as readily as its input: `$(echo $(cat <<EOF …))`.
    pushAll(frame.fed, frame.printed);
    frame.words = [];
    frame.redirects = [];
    frame.input = [];
    frame.printed = [];
    frame.literal = true;
    frame.place = "name";
    frame.redirected = false;
    frame.target = "argument";
  }

  private endPipeline(frame: Frame): void {
    this.endCommand(frame);
    if (frame.piped) {
      joinGroup(frame);
    }
    pushAll(this.pipelines, frame.group.splice(0));
    if (frame.pipeline.length > 0) {
      this.pipelines.push(frame.pipeline);
    }
    frame.pipeline = [];
    frame.piped = false;
  }
}

const read = (line: string, reading: Reading): Scanner => {
  const scanner = new Scanner(line, reading);
  scanner.list(null);
  return scanner;
};

/** The flat reading alone, for text too deep to follow: more commands than bash would run, found without recursing. */
export const lexFlat = (line: string): Pipeline[] => read(line, "flat").pipelines;

/** Each pipeline the readings found, once however many found it. */
const union = (readings: readonly Scanner[]): Pipeline[] => {
  const seen = new Set<string>();
  const pipelines: Pipeline[] = [];
  for (const reading of readings) {
    for (const pipeline of reading.pipelines) {
      const key = JSON.stringify(pipeline);
      if (!seen.has(key)) {
        seen.add(key);
        pipelines.push(pipeline);
      }
    }
  }
  return pipelines;
};

/**
 * Every pipeline a command line runs, in the order bash starts them: a
 * substitution's before the command it feeds. A line dialects may read apart
 * is read in each as well, and a line the strict reading cannot follow is read
 * flat, so neither a stray quote nor one shell's grammar can hide what comes
 * after it.
 */
export const lexLine = (line: string): Pipeline[] => {
  const bash = read(line, "bash");
  const readings = bash.divergent
    ? [bash, read(line, "zsh"), read(line, "posix"), read(line, "bash-3.2")]
    : [bash];
  const pipelines = bash.divergent ? union(readings) : bash.pipelines;
  return readings.some((reading) => reading.unreadable)
    ? [...pipelines, ...lexFlat(line)]
    : pipelines;
};
