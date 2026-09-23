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
}

/** Simple commands joined by `|`, in the order data flows through them. */
export type Pipeline = readonly Command[];

/** Past this many nested substitutions, subshells and expansions the line is read flat instead of recursing. */
const MAX_DEPTH = 64;

/** What a flat reading takes for the start of a new command: a quote may open a script (`sh -c '…'`). */
const OPENERS = ["$(", "$'", '$"', "<(", ">(", "(", "`", "'", '"'];

/** Operators that end a command, longest first: all but a pipe also end its pipeline. */
const SEPARATORS = ["&&", "||", "|&", "|", ";", "&", ")", "\n"];
const PIPES = new Set(["|", "|&"]);

/** Redirections: the word after one names a file, a descriptor or a heredoc's end, never an argument. */
const REDIRECTION = /&>>?|<<<|<<-?|[<>]&|<>|>>|>\||[<>]/uy;
const DESCRIPTOR = /^\d+$/u;
const LEADING_TABS = /^\t+/u;
const LINE_END = /\r$/u;
const FUNCTION_PARENS = /\([ \t]*\)/uy;
/** Text no reading treats specially, taken whole rather than a character at a time. */
const PLAIN_RUN = /[^\s$`<>'"\\|&;()]+/uy;

/** Words that can come before a command's own name in what is read as one command: `if case …`. */
const KEYWORDS = new Set(["!", "{", "do", "elif", "else", "if", "then", "time", "until", "while"]);

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
  target: Target;
  /** Whether the command has a redirection, which makes it one even with no words: `(cat) <<EOF | sh`. */
  redirected: boolean;
  /** Whether the command has a word besides keywords yet: only its first such word can open or close a `case`. */
  named: boolean;
  /** `case` commands not yet closed by `esac`: until then a `)` ends a pattern, not the list. */
  cases: number;
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

/** `case` and `esac` count only as a command's name, unquoted: `echo case` opens nothing. */
const countCase = (frame: Frame, word: string): void => {
  if (frame.named || frame.quoted) {
    frame.named = true;
    return;
  }
  if (word === "case") {
    frame.cases += 1;
  } else if (word === "esac" && frame.cases > 0) {
    frame.cases -= 1;
  }
  frame.named = !KEYWORDS.has(word);
};

const joinGroup = (frame: Frame): void => {
  for (const pipeline of frame.group.splice(0)) {
    pushAll(frame.pipeline, pipeline);
  }
};

/**
 * Reads one line. A strict reading follows bash. A flat one takes every quote
 * and opener for a command start, and every heredoc or comment line for a line
 * of commands, so it needs no recursion and finds a command wherever one could start.
 */
class Scanner {
  readonly pipelines: Pipeline[] = [];
  /** A quote never closed (bash refuses the line) or nesting too deep to follow. */
  unreadable = false;
  private at = 0;
  private depth: number;
  private frame: Frame | null = null;
  private readonly pending: Heredoc[] = [];
  /** Where a `((` was read to its end and turned out to open subshells, so it is not taken for arithmetic again. */
  private readonly subshells = new Set<number>();
  private readonly text: string;
  private readonly strict: boolean;

  constructor(text: string, strict: boolean, depth = 0) {
    this.text = text;
    this.strict = strict;
    this.depth = depth;
  }

  /** Reads commands until `close` (a substitution's or subshell's end) or the end of the text, and returns what they were fed. */
  list(close: string | null): Words[] {
    const frame: Frame = {
      cases: 0,
      fed: [],
      group: [],
      input: [],
      named: false,
      piped: false,
      pipeline: [],
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
      append(frame, arithmetic);
      return;
    }
    this.endWord(frame);
    FUNCTION_PARENS.lastIndex = this.at;
    const [parens] = FUNCTION_PARENS.exec(this.text) ?? [];
    if (parens !== undefined && frame.words.length > 0) {
      // A definition runs nothing, so its name is no command: `vercel() { … }` deploys nothing.
      frame.words = [];
      frame.named = false;
      this.at += parens.length;
      return;
    }
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
      return true;
    }
    // A pipe at the end of a line feeds the next line: `curl … |`, then `bash`.
    const piping = frame.pipeline.length > 0 && frame.words.length === 0 && frame.word === null;
    if (operator !== "\n" || !piping) {
      this.endPipeline(frame);
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
      append(frame, run);
      this.at += run.length;
      return;
    }
    const substituted =
      this.expansion() ?? this.substitution(char) ?? this.processSubstitution(char);
    if (substituted !== null) {
      append(frame, substituted);
      return;
    }
    const quoted = this.quoted(char);
    if (quoted !== null) {
      frame.quoted = true;
      append(frame, quoted);
    } else if (char === "\\") {
      this.escape(frame);
    } else {
      append(frame, char);
      this.at += 1;
    }
  }

  /** A quoted string that starts here, with its quotes and escapes resolved. */
  private quoted(char: string): string | null {
    const next = this.text.charAt(this.at + 1);
    if (char === "'") {
      return this.singleQuoted();
    }
    if (char === '"') {
      return this.doubleQuoted();
    }
    if (char === "$" && next === "'") {
      return this.ansiQuoted();
    }
    if (char === "$" && next === '"') {
      // A string for translation, which bash reads as double quotes.
      this.at += 1;
      return this.doubleQuoted();
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
    this.at = start;
    this.pending.splice(0);
    pushAll(this.pending, before.pending);
    this.pipelines.splice(before.pipelines);
    this.frame?.printed.splice(before.printed);
    this.unreadable = before.unreadable;
    return null;
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
      const inner = new Scanner(unescaped, this.strict, this.depth);
      pushAll(this.frame?.printed ?? [], inner.list(null));
      pushAll(this.pipelines, inner.pipelines);
      this.unreadable ||= inner.unreadable;
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

  private doubleQuoted(): string {
    let text = "";
    this.at += 1;
    while (this.at < this.text.length) {
      const char = this.text.charAt(this.at);
      if (char === '"') {
        this.at += 1;
        return text;
      }
      text += this.quotedPart(char);
    }
    this.unreadable = true;
    return text;
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
      countCase(frame, frame.word);
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
    frame.target = "argument";
  }

  private endCommand(frame: Frame): void {
    this.endWord(frame);
    if (frame.words.length > 0 || frame.redirected) {
      frame.pipeline.push({
        input: frame.input,
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
    frame.named = false;
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

/** The flat reading alone, for text too deep to follow: more commands than bash would run, found without recursing. */
export const lexFlat = (line: string): Pipeline[] => {
  const flat = new Scanner(line, false);
  flat.list(null);
  return flat.pipelines;
};

/**
 * Every pipeline a command line runs, in the order bash starts them: a
 * substitution's before the command it feeds. A line the strict reading cannot
 * follow is read flat as well, so a stray quote cannot hide what comes after it.
 */
export const lexLine = (line: string): Pipeline[] => {
  const strict = new Scanner(line, true);
  strict.list(null);
  return strict.unreadable ? [...strict.pipelines, ...lexFlat(line)] : strict.pipelines;
};
