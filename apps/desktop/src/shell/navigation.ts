type Verdict = "allow" | "open-externally" | "deny";

const knownPort = (protocol: string) => {
  if (protocol === "http:") {
    return "80";
  }

  return protocol === "https:" ? "443" : null;
};

const parsed = (url: string) => (URL.canParse(url) ? new URL(url) : null);

/**
 * The origin a window is pinned to, compared by its parts: not a prefix of the address, which
 * `http://127.0.0.1:4664@evil.example/` shares with a pin on 127.0.0.1:4664, and a url with a
 * login is no origin here, since main's page carries none.
 */
export const comparableOrigin = (url: URL) => {
  if (url.username !== "" || url.password !== "" || url.hostname === "") {
    return null;
  }

  const scheme = url.protocol.slice(0, -1);
  const port = url.port === "" ? knownPort(url.protocol) : url.port;

  return port === null ? `${scheme}://${url.hostname}` : `${scheme}://${url.hostname}:${port}`;
};

/** Whether the browser is where `url` goes. */
export const isWebUrl = (url: string) => {
  const protocol = parsed(url)?.protocol;

  return protocol === "http:" || protocol === "https:";
};

/**
 * The origin of main's page, from the link main hands the shell: plain http on 127.0.0.1 at the
 * port main bound, and nothing else, since the window pinned to it holds the founder's approve
 * button.
 */
export const pageOrigin = (link: string) => {
  const url = parsed(link);

  if (
    url === null ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.port === "0"
  ) {
    return null;
  }

  return comparableOrigin(url);
};

/**
 * Main's own page stays, any other web page opens in the browser, and nothing else loads, so a link
 * in an agent-written page or an injected script cannot navigate the window away from main. The
 * office draws no frame, so `about:blank` is refused too.
 */
export const classify = (target: string, pinned: string) => {
  const url = parsed(target);
  let verdict: Verdict = "deny";

  if (url !== null && comparableOrigin(url) === pinned) {
    verdict = "allow";
  } else if (isWebUrl(target)) {
    verdict = "open-externally";
  }

  return verdict;
};

export const EXTERNAL_OPEN_SPACING_MS = 1000;

/**
 * A script can navigate the page with no click, and each refused navigation to a web page opens the
 * browser, so it opens at most once a second rather than in a loop.
 */
export const createExternalOpens = () => {
  let last: number | null = null;

  return {
    allow: (now: number) => {
      const allowed = last === null || now - last >= EXTERNAL_OPEN_SPACING_MS;

      if (allowed) {
        last = now;
      }

      return allowed;
    },
  };
};
