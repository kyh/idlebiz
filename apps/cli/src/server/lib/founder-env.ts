// Who the founder is, and the env main hands what it starts outside a run's seal. Main's own env is
// launchd's in the packaged app, which any process of the founder's, a run's included, sets for
// every app opened after it (`launchctl setenv`).

/** macOS's own PATH, as launchd sets it by default: folders SIP keeps and no run writes. */
export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// who the founder is and how they read text, as login(1) hands a shell: nothing a program reads to
// load more
const ACCOUNT_NAMES = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "__CF_USER_TEXT_ENCODING",
] as const;

const PROXY = /^(?:https?|all|no)_proxy$/iu;

type Env = Readonly<Record<string, string | undefined>>;

const picked = (env: Env, keep: (name: string) => boolean): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && keep(entry[0]),
    ),
  );

/**
 * What a program main starts outside a run's seal starts from: the account's names, the locale and
 * `extra`, never main's env whole, in which ZDOTDIR moves a shell's startup files, BASH_ENV and
 * exported functions run in bash, GIT_TEMPLATE_DIR copies hooks, DEVELOPER_DIR picks xcrun's tools
 * and CURL_HOME a .curlrc.
 */
export const unsealedEnv = (env: Env, extra: Readonly<Record<string, string>>) => ({
  ...picked(env, (name) => ACCOUNT_NAMES.some((kept) => kept === name)),
  ...extra,
});

/** The founder's proxies, in either case: one can route a download, never answer for its host. */
export const proxiesOf = (env: Env): Record<string, string> =>
  picked(env, (name) => PROXY.test(name));

/** What of `env` is named with one of `prefixes`: a runner's provider settings. */
export const namedWith = (env: Env, prefixes: readonly string[]): Record<string, string> =>
  picked(env, (name) => prefixes.some((prefix) => name.startsWith(prefix)));

/**
 * Why a packaged main refuses the HOME and SHELL it was started with, or null when they are the
 * account's, as the user database says: the shell hands it the account's, so any other means it
 * did not, and the save, the seal and the PATH the runs find their CLIs on all come from them.
 */
export const identityRefusal = (
  home: string,
  shell: string | undefined,
  account: { readonly homedir: string; readonly shell: string | null },
): string | null => {
  if (home !== account.homedir) {
    return `IdleBiz was started with ${home} as your home folder, but macOS says yours is ${account.homedir}: it opens a save and seals runs only under the home folder that is yours.`;
  }
  const started = shell ?? "";
  const yours = account.shell ?? "";
  if (started !== yours) {
    return `IdleBiz was started with ${started === "" ? "no shell" : started} as your shell, but macOS says yours is ${yours === "" ? "none" : yours}: it looks for your coding CLIs only on the PATH your own shell sets.`;
  }
  return null;
};
