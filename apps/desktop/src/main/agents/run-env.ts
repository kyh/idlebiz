/** Whole underscore-separated segments: `GH_TOKEN` and `X_AUTH` match, `GIT_AUTHOR_NAME` does not. */
const CREDENTIAL =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH)(?:_|$)/iu;

/**
 * A path to the founder's ssh agent, not a key: ambient logins are not this filter's to
 * withhold, and dropping it would only break a push the founder signed for.
 */
const SSH_AGENT = "SSH_AUTH_SOCK";

const reaches = (name: string, keep: readonly string[]): boolean =>
  name === SSH_AGENT || !CREDENTIAL.test(name) || keep.some((prefix) => name.startsWith(prefix));

/**
 * The environment a run starts from: `base` less every variable named like a credential,
 * except those starting with one of `keep`, the runner's own login.
 */
export const runEnv = (
  base: Readonly<Record<string, string | undefined>>,
  keep: readonly string[],
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && reaches(entry[0], keep),
    ),
  );
