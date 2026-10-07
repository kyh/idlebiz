/**
 * Whole underscore-separated segments: `GH_TOKEN`, `X_AUTH` and `STRIPE_KEY` match,
 * `GIT_AUTHOR_NAME` and `PATH` do not. A webhook's or a DSN's URL is its own credential, and
 * `SSH_AUTH_SOCK` is the founder's ssh agent, which signs as them with no key file.
 */
const CREDENTIAL =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|KEY|PAT|DSN|WEBHOOK|CREDENTIALS?|AUTH)(?:_|$)/iu;

/** A proxy's login is how every request out, the runner's to its model included, gets through. */
const PROXY = /(?:^|_)PROXY$/iu;

/** A URL carrying its own login, like `postgres://app:hunter2@db/prod`, whatever it is named. */
const hasLogin = (value: string): boolean => {
  const url = URL.parse(value);
  return url !== null && (url.username !== "" || url.password !== "");
};

const reaches = (name: string, value: string, keep: readonly string[]): boolean =>
  keep.some((prefix) => name.startsWith(prefix)) ||
  (!CREDENTIAL.test(name) && (PROXY.test(name) || !hasLogin(value)));

/**
 * The environment a run starts from: `base` less every variable named like a credential
 * or holding a URL with a login in it, except those starting with one of `keep`, the
 * runner's own login.
 */
export const runEnv = (
  base: Readonly<Record<string, string | undefined>>,
  keep: readonly string[],
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && reaches(entry[0], entry[1], keep),
    ),
  );
