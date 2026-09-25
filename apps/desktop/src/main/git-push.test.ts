import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefusalError } from "@/shared/refusal";
import type { PushTarget } from "./git-push";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-push-root-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { PUSH_STAGING_DIR, gitPush, pusherOver, redacted, refusesLazyFetch } =
  await import("./git-push");

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("/usr/bin/git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();

const commit = (repo: string, message: string, ...args: string[]): string => {
  git(
    repo,
    "-c",
    "user.name=Priya",
    "-c",
    "user.email=priya@acme.test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
    ...args,
  );
  return git(repo, "rev-parse", "HEAD");
};

/** The commit `branch` points at in the bare repository `bare`, or null when it has none. */
const tipOf = (bare: string, branch = "main"): string | null => {
  try {
    return git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return null;
  }
};

let box = "";
let workspace = "";
let remote = "";
let remoteUrl = "";
const pushToDisk = pusherOver(["file"]);
const request = () => ({ branch: null, remote: "origin", repo: workspace });
const allow = (): void => {};

beforeEach(() => {
  // the push reads the founder's own git config; this machine's must not steer the tests
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-push-")));
  workspace = path.join(box, "workspace");
  remote = path.join(box, "remote.git");
  remoteUrl = `file://${remote}`;
  mkdirSync(workspace);
  git(box, "init", "--quiet", "--bare", remote);
  git(workspace, "init", "--quiet", "--initial-branch=main");
  git(workspace, "remote", "add", "origin", remoteUrl);
});

afterEach(() => {
  const staged = readdirSync(PUSH_STAGING_DIR);
  rmSync(box, { force: true, recursive: true });
  vi.unstubAllEnvs();
  expect(staged).toEqual([]);
});

describe("pushing a workspace's branch", () => {
  it("pushes the checked-out branch's commit to the remote's URL, and says what git said", async () => {
    const sha = commit(workspace, "first");
    const signed: PushTarget[] = [];
    const pushed = await pushToDisk(request(), (target) => signed.push(target));
    expect(signed).toEqual([{ branch: "main", sha, url: remoteUrl }]);
    expect(pushed.kind).toBe("pushed");
    expect(pushed.said).toContain("main -> main");
    expect(tipOf(remote)).toBe(sha);
  });

  it("runs nothing the workspace's config or hooks name, and goes where the remote says, not where its rewrites would", async () => {
    const sha = commit(workspace, "first");
    const marker = path.join(box, "ran");
    const evil = path.join(box, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(evil, 0o755);
    const decoy = path.join(box, "decoy.git");
    git(box, "init", "--quiet", "--bare", decoy);
    const hooks = path.join(box, "hooks");
    mkdirSync(hooks);
    for (const hook of [
      "pre-push",
      "reference-transaction",
      "post-update",
      "pre-auto-gc",
      "post-checkout",
    ]) {
      for (const dir of [hooks, path.join(workspace, ".git", "hooks")]) {
        writeFileSync(path.join(dir, hook), `#!/bin/sh\n'${evil}'\n`);
        chmodSync(path.join(dir, hook), 0o755);
      }
    }
    appendFileSync(
      path.join(workspace, ".git", "config"),
      [
        "[core]",
        `\thooksPath = ${hooks}`,
        `\tsshCommand = ${evil}`,
        `\tfsmonitor = ${evil}`,
        `\talternateRefsCommand = ${evil}`,
        "[credential]",
        `\thelper = !${evil}`,
        "[uploadpack]",
        `\tpackObjectsHook = ${evil}`,
        `[url "file://${decoy}"]`,
        `\tinsteadOf = ${remoteUrl}`,
        `\tpushInsteadOf = ${remoteUrl}`,
        "",
      ].join("\n"),
    );

    const pushed = await pushToDisk(request(), allow);
    expect(pushed.kind).toBe("pushed");
    expect(tipOf(remote)).toBe(sha);
    expect(tipOf(decoy)).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it("runs no ssh a run could have put first on PATH", async () => {
    commit(workspace, "first");
    const marker = path.join(box, "ran");
    const bin = path.join(box, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(path.join(bin, "ssh"), 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    // the system ssh it falls back to must not read the founder's ssh config or ask their agent
    vi.stubEnv("GIT_SSH_COMMAND", "ssh -F /dev/null -o BatchMode=yes");
    vi.stubEnv("SSH_AUTH_SOCK", "");
    // nothing listens on port 1, so the system ssh gives up at once
    git(workspace, "remote", "set-url", "origin", "ssh://git@127.0.0.1:1/x.git");

    const pushed = await pusherOver(["ssh"])(request(), allow);
    expect(pushed.kind).toBe("rejected");
    expect(pushed.said).toContain("Connection refused");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a partial clone, and runs nothing its promisor remote names", async () => {
    const marker = path.join(box, "ran");
    const evil = path.join(box, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(evil, 0o755);
    const source = path.join(box, "source");
    git(box, "init", "--quiet", "--initial-branch=main", source);
    git(source, "config", "uploadpack.allowFilter", "true");
    writeFileSync(path.join(source, "index.html"), "<h1>Acme</h1>\n");
    git(source, "add", "index.html");
    commit(source, "first");
    const partial = path.join(box, "partial");
    git(
      box,
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      `file://${source}`,
      partial,
    );
    git(partial, "config", "remote.origin.uploadpack", evil);
    // how upload-pack behaves in a git without the fix, which lazy-fetches what a partial clone lacks
    vi.stubEnv("GIT_NO_LAZY_FETCH", "0");

    await expect(pushToDisk({ ...request(), repo: partial }, allow)).rejects.toThrow(
      "partial clone",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("pushes nothing while the sign-off holds it", async () => {
    commit(workspace, "first");
    const held = new RefusalError("held");
    await expect(
      pushToDisk(request(), () => {
        throw held;
      }),
    ).rejects.toBe(held);
    expect(tipOf(remote)).toBeNull();
  });

  it("pushes a branch it is named, whatever is checked out", async () => {
    commit(workspace, "first");
    git(workspace, "switch", "--quiet", "-c", "feature/pricing");
    const sha = commit(workspace, "pricing");
    git(workspace, "switch", "--quiet", "main");
    const signed: PushTarget[] = [];
    await pushToDisk({ ...request(), branch: "feature/pricing" }, (target) => signed.push(target));
    expect(signed.map((target) => target.branch)).toEqual(["feature/pricing"]);
    expect(tipOf(remote, "feature/pricing")).toBe(sha);
  });

  it("answers with git's words when the remote turns the push down, and never forces", async () => {
    const first = commit(workspace, "first");
    await pushToDisk(request(), allow);
    commit(workspace, "rewritten", "--amend");
    const pushed = await pushToDisk(request(), allow);
    expect(pushed.kind).toBe("rejected");
    expect(pushed.said).toContain("rejected");
    expect(tipOf(remote)).toBe(first);
  });

  it.each([
    ["no commit yet", () => {}, "no branch checked out"],
    [
      "a detached HEAD",
      () => {
        commit(workspace, "first");
        git(workspace, "switch", "--quiet", "--detach");
      },
      "no branch checked out",
    ],
  ])("asks for a branch when the workspace has %s", async (_, arrange, answer) => {
    arrange();
    await expect(pushToDisk(request(), allow)).rejects.toThrow(answer);
  });

  it("refuses a branch the workspace does not have, or git would not name", async () => {
    commit(workspace, "first");
    await expect(pushToDisk({ ...request(), branch: "nope" }, allow)).rejects.toThrow(
      "git could not read nope from the workspace",
    );
    await expect(pushToDisk({ ...request(), branch: "a..b" }, allow)).rejects.toThrow(
      "is not a branch name git takes",
    );
    await expect(pushToDisk({ ...request(), branch: "main\u202Eevil" }, allow)).rejects.toThrow(
      "is not a branch name git takes",
    );
  });

  it("refuses a workspace with no such remote, or one naming more than one URL", async () => {
    commit(workspace, "first");
    await expect(pushToDisk({ ...request(), remote: "upstream" }, allow)).rejects.toThrow(
      'no remote "upstream"',
    );
    git(workspace, "config", "--add", "remote.origin.pushurl", remoteUrl);
    git(workspace, "config", "--add", "remote.origin.pushurl", `${remoteUrl}.bak`);
    await expect(pushToDisk(request(), allow)).rejects.toThrow("more than one URL");
  });

  it("refuses a repository git cannot read", async () => {
    rmSync(path.join(workspace, ".git", "HEAD"));
    await expect(pushToDisk(request(), allow)).rejects.toBeInstanceOf(RefusalError);
  });
});

describe("where the app pushes", () => {
  const HELD = new RefusalError("held for the founder");
  const signed: string[] = [];
  /** gitPush held at the sign-off, so nothing it is asked to sign ever goes out. */
  const heldPush = () =>
    gitPush(request(), (target) => {
      signed.push(target.url);
      throw HELD;
    });
  /** heldPush with origin at `url`, written as it stands (git's own CLI takes no URL starting "-"). */
  const pushTo = (url: string) => {
    git(workspace, "remote", "remove", "origin");
    appendFileSync(path.join(workspace, ".git", "config"), `[remote "origin"]\n\turl = "${url}"\n`);
    commit(workspace, "first");
    return heldPush();
  };

  beforeEach(() => {
    signed.length = 0;
  });

  it.each([
    "https://github.com/acme/site.git",
    "ssh://git@github.com/acme/site.git",
    "ssh://git@git.acme.test:2222/site.git",
    "git@github.com:acme/site.git",
    "github.com:acme/site.git",
  ])("asks the founder to push to %s as it stands", async (url) => {
    await expect(pushTo(url)).rejects.toBe(HELD);
    expect(signed).toEqual([url]);
  });

  it("prefers the remote's push URL", async () => {
    commit(workspace, "first");
    git(workspace, "remote", "set-url", "origin", "https://github.com/acme/site.git");
    git(workspace, "remote", "set-url", "--push", "origin", "git@github.com:acme/site.git");
    await expect(heldPush()).rejects.toBe(HELD);
    expect(signed).toEqual(["git@github.com:acme/site.git"]);
  });

  it("refuses a remote helper, and runs nothing it names", async () => {
    const marker = path.join(box, "ran");
    const evil = path.join(box, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(evil, 0o755);
    await expect(pushTo(`ext::${evil}`)).rejects.toThrow("which the push tool does not reach");
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["a remote helper", "ext::sh -c touch% /tmp/pwned"],
    ["a file descriptor", "fd::3"],
    ["a path on disk", "/tmp/elsewhere.git"],
    ["a file URL", "file:///tmp/elsewhere.git"],
    ["plain http", "http://github.com/acme/site.git"],
    ["git's own protocol", "git://github.com/acme/site.git"],
    ["an ssh option for a host", "ssh://-oProxyCommand=touch/site.git"],
    ["an ssh option for a login", "-oProxyCommand=touch@github.com:site.git"],
    ["an ssh option for a login in a URL", "ssh://-oProxyCommand=touch@github.com/site.git"],
    ["a host with no name", "https:///acme/site.git"],
    ["an unseen character", "https://github.com/acme/site\u202E.git"],
    ["a space", "https://github.com/acme/my site.git"],
  ])("refuses %s", async (_, url) => {
    await expect(pushTo(url)).rejects.toThrow("the push tool takes https://host/path");
    expect(signed).toEqual([]);
  });

  it("refuses a URL with a login in it, and never repeats the login", async () => {
    const refused = pushTo("https://priya:ghp_secret@github.com/acme/site.git");
    await expect(refused).rejects.toThrow("with a login in it");
    await expect(refused).rejects.not.toThrow("ghp_secret");
    git(workspace, "remote", "set-url", "origin", "https://ghp_secret@github.com/acme/site.git");
    await expect(heldPush()).rejects.toThrow('"https://***@github.com/acme/site.git"');
  });
});

describe("refusesLazyFetch", () => {
  it.each([
    ["git version 2.39.3 (Apple Git-146)", false],
    ["git version 2.39.4", true],
    ["git version 2.39.5 (Apple Git-154)", true],
    ["git version 2.40.1", false],
    ["git version 2.40.2", true],
    ["git version 2.43.3", false],
    ["git version 2.43.4", true],
    ["git version 2.45.0", false],
    ["git version 2.45.1", true],
    ["git version 2.46.0.rc1", true],
    ["git version 2.54.0 (Apple Git-157)", true],
    ["git version 3.0.0", true],
    ["git version 1.9.9", false],
    ["xcode-select: note: No developer tools were found", false],
  ])("%s: %s", (version, refuses) => {
    expect(refusesLazyFetch(version)).toBe(refuses);
  });
});

describe("redacted", () => {
  it("blanks an https login and any password, and keeps an ssh login", () => {
    expect(
      redacted(
        "To https://x-access-token:ghp_1@github.com/a.git\nfrom http://tok@host/b and ssh://git@github.com/c and ssh://u:p@h/d",
      ),
    ).toBe(
      "To https://***@github.com/a.git\nfrom http://***@host/b and ssh://git@github.com/c and ssh://***@h/d",
    );
  });
});
