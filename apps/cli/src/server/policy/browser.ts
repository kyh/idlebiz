import { z } from "zod";
import type { HoldRuleId } from "@repo/domain/hold-rules";
import { parseJson } from "@repo/domain/json";
import type { Words } from "../shell-lexer";
import { wordsOf } from "./reading";
import type { Call } from "./reading";

const LOOPBACK_HOST = String.raw`https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)`;
// Not file:, which is no build of the team's: a page opened from disk reads the disk.
const LOOPBACK_URL = new RegExp(`^(?:${LOOPBACK_HOST}|about:)`, "u");
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

/**
 * The URL of the top page, then of every frame found under it; null where the
 * reading frame's origin may not look. `get url` names only the top page, while a
 * ref act can land in any frame. The walk starts at `top`, wherever the session is
 * switched. `window.frames` leaves out frames in shadow roots, and a page's own
 * `var length` hides the rest, so each readable document is searched as well, open
 * roots included; a frame in a closed root shows only in resource timing, once it
 * has loaded, by the URL it first asked for; frames inside it not at all.
 */
export const PAGE_URLS = `(() => {
  const urls = [];
  const seen = new Set();
  const walk = (w) => {
    if (w == null || seen.has(w)) return;
    seen.add(w);
    let url = null;
    let doc = null;
    try { url = w.location.href; doc = w.document; } catch {}
    urls.push(url);
    for (let i = 0; i < w.length; i += 1) walk(w[i]);
    if (doc === null) return;
    const roots = [doc];
    for (let root = roots.pop(); root !== undefined; root = roots.pop()) {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.contentWindow) walk(el.contentWindow);
      }
    }
    for (const entry of w.performance.getEntriesByType("resource")) {
      if (["iframe", "frame", "object", "embed"].includes(entry.initiatorType)) urls.push(entry.name);
    }
  };
  walk(window.top);
  return urls;
})()`;

/** agent-browser's answer to these words: what it printed. */
export type BrowserCli = (args: readonly string[]) => Promise<string>;

const SessionInfo = z.object({ data: z.object({ active: z.boolean() }) });

const LivePageOutput = z.object({ data: z.object({ result: z.array(z.string().nullable()) }) });

/** The page `session` in `namespace` shows, read through `browser`; null when nothing could say. */
const readPage = async (
  browser: BrowserCli,
  namespace: string,
  session: string,
): ReturnType<LivePage> => {
  const scope = ["--namespace", namespace, ...(session === "" ? [] : ["--session", session])];
  try {
    const info = SessionInfo.safeParse(
      parseJson(await browser([...scope, "session", "info", "--json"])),
    );
    if (!info.success || !info.data.data.active) {
      return null;
    }
    const page = LivePageOutput.safeParse(
      parseJson(await browser([...scope, "eval", PAGE_URLS, "--json"])),
    );
    const [url = null, ...frames] = page.success ? page.data.data.result : [];
    return url === null ? null : { frames, url };
  } catch {
    return null;
  }
};

/**
 * Ask the browser itself: the session is the run's, but any process of this user can read it.
 * Only a daemon already running is read, since `eval` starts one where none runs: a session with
 * no daemon shows no page, so an act on it waits on the founder. `browser` is agent-browser as
 * the run starts it, so a daemon that stops between the two reads comes back sealed all the same.
 */
export const livePageOf =
  (browser: BrowserCli, namespace: string): LivePage =>
  (session) =>
    readPage(browser, namespace, session);

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

// agent-browser hands a URL of this scheme, in any case, to the browser as written.
const FILE_URL = /^file:/iu;

const decoded = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** The run's own folders, which a page opened from disk is judged against. Absolute paths. */
export interface Confinement {
  /** The run's working directory: a relative path is read from here. */
  cwd: string;
  /** Its cwd and every directory the run was granted. */
  writable: readonly string[];
  /** Where an absolute path leads on disk, every symlink on its way followed. */
  real: (file: string) => Promise<string>;
}

/**
 * Whether `word` is a `file:` URL for anything outside the run's own dirs, or one nobody can
 * place. Judged where it leads, as the browser opens it: a run can link its workspace anywhere.
 */
const opensOutside = async (word: string, room: Confinement): Promise<boolean> => {
  if (!FILE_URL.test(word)) {
    return false;
  }
  const url = URL.parse(word);
  const file = url === null ? null : decoded(url.pathname);
  if (url === null || file === null || (url.host !== "" && url.host !== "localhost")) {
    return true;
  }
  const opened = await room.real(resolvePath("/", file));
  const roots = await Promise.all(room.writable.map(room.real));
  return !roots.some((root) => within(opened, root));
};

/** What a browser command waits on: the approval key, under the browser rule that held it. */
interface BrowserHold {
  key: string;
  rule: Extract<HoldRuleId, "browser-act" | "browser-file" | "browser-unseen">;
}

const unseen = (command: string): BrowserHold => ({ key: command, rule: "browser-unseen" });

/** What acting on the page at `url` waits on, or null when it may run. A null `url` is a page nobody knows. */
const actHold = (
  url: string | null,
  leases: ReadonlySet<string>,
  command: string,
): BrowserHold | null => {
  if (onLoopback(url)) {
    return null;
  }
  const host = url === null ? null : hostOf(url);
  if (host === null) {
    return unseen(command);
  }
  const key = `agent-browser: act on ${host}`;
  return leases.has(key) ? null : { key, rule: "browser-act" };
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
 * A file outside the run's own dirs is held wherever it is named, since any verb
 * that takes a URL (`open`, `tab new`, `diff url`) reads it into a page.
 */
export const heldBrowserAct = async (
  pipelines: readonly (readonly Call[])[],
  key: string,
  leases: ReadonlySet<string>,
  livePage: LivePage,
  room: Confinement,
): Promise<BrowserHold | null> => {
  // Per session, where the page will be when the next step runs: absent is where the live page says, null is anywhere.
  const pages = new Map<string, string | null>();
  const land = (session: string, url: string | null): void => {
    pages.set(session, url);
    const alias = SESSION_ALIASES.get(session);
    if (alias !== undefined) {
      pages.set(alias, null);
    }
  };
  const calls = pipelines.flat().filter((call) => call.program === "agent-browser");
  const opened = await Promise.all(
    calls.flatMap((call) => call.args).map((word) => opensOutside(word, room)),
  );
  if (opened.includes(true)) {
    return { key, rule: "browser-file" };
  }
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
