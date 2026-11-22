const CREDENTIAL =
  /(?:^|_)(?:TOKEN|[A-Z0-9]*SECRET|[A-Z0-9]*PASSWORD|PASSWD|PASS|PASSPHRASE|APIKEY|KEY|PAT|DSN|WEBHOOK|CREDENTIALS?|AUTH)(?:_|$)|^(?:MYSQL_PWD|BW_SESSION|OP_SESSION_)/iu;

const PROXY = /(?:^|_)PROXY$/iu;

const hasLogin = (value: string) => {
  const url = URL.parse(value);

  return url !== null && (url.username !== "" || url.password !== "");
};

const reaches = (name: string, value: string, keep: readonly string[]) =>
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
) =>
  Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && reaches(entry[0], entry[1], keep),
    ),
  );
