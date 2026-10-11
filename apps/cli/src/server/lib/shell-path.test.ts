import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptShellPath, runShell } from "./shell-path";

const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const adopted = (): string[] => process.env.PATH?.split(path.delimiter) ?? [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The founder's login shell is zsh under a stand-in home, whose startup puts folders on PATH,
// one not made yet.
describe.skipIf(process.platform !== "darwin")("adoptShellPath", () => {
  const touched = ["HOME", "PATH", "SHELL", "ZDOTDIR"];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  let box = "";
  let home = "";

  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-shell-")));
    home = path.join(box, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(home, "bin"));
    mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    writeFileSync(path.join(home, ".zprofile"), 'export PATH="$HOME/.bun/bin:$HOME/bin:$PATH"\n');
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = LAUNCHD_PATH;
    delete process.env.ZDOTDIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(box, { force: true, recursive: true });
  });

  it("takes the login shell's PATH, folders not made yet included", async () => {
    await adoptShellPath(true);

    expect(adopted().slice(0, 2)).toEqual([path.join(home, ".bun/bin"), path.join(home, "bin")]);
    expect(adopted()).toContain(path.join(home, ".local/bin"));
    expect(adopted()).not.toContain(path.join(home, ".cargo/bin"));
  });

  it("keeps the folder onboarding installs Claude Code into before it exists", async () => {
    rmSync(path.join(home, ".local"), { force: true, recursive: true });

    await adoptShellPath(true);

    expect(adopted()).toContain(path.join(home, ".local/bin"));
  });

  it("puts the known folders on PATH at once, and the shell's ahead of them once it answers", async () => {
    const settled = adoptShellPath(true);

    expect(adopted()[0]).toBe(path.join(home, ".local/bin"));
    expect(adopted()).not.toContain(path.join(home, "bin"));
    await settled;
    expect(adopted().slice(0, 2)).toEqual([path.join(home, ".bun/bin"), path.join(home, "bin")]);
  });

  it("keeps the known folders when the shell cannot start", async () => {
    process.env.SHELL = path.join(box, "no-such-shell");

    await adoptShellPath(true);

    expect(adopted()[0]).toBe(path.join(home, ".local/bin"));
    expect(adopted()).toEqual(expect.arrayContaining(LAUNCHD_PATH.split(":")));
    expect(adopted()).not.toContain(path.join(home, "bin"));
  });

  it("leaves a development launch its terminal's PATH and asks no shell", async () => {
    await adoptShellPath(false);

    expect(adopted()).toEqual([...LAUNCHD_PATH.split(":"), path.join(home, ".local/bin")]);
  });

  it("settles though an rc file reads stdin and leaves a sleeper on stdout, and leaves no process behind", async () => {
    const pids = path.join(box, "pids");
    writeFileSync(
      path.join(home, ".zshrc"),
      `read -r answer\nsleep 30 &\necho "$$ $!" > ${pids}\n`,
    );
    const started = Date.now();

    await adoptShellPath(true);

    expect(Date.now() - started).toBeLessThan(4000);
    expect(adopted()[0]).toBe(path.join(home, ".bun/bin"));
    const [shell = 0, sleeper = 0] = readFileSync(pids, "utf-8").trim().split(" ").map(Number);
    await expect.poll(() => [alive(shell), alive(sleeper)]).toEqual([false, false]);
  });
});

describe("runShell", () => {
  it("answers what the command printed", async () => {
    await expect(runShell("/bin/sh", ["-c", "echo one; echo two"], 5000)).resolves.toBe(
      "one\ntwo\n",
    );
  });

  it("gives up at its deadline on a shell that never prints the PATH, and kills what it started", async () => {
    const box = mkdtempSync(path.join(tmpdir(), "idlebiz-shell-"));
    const pid = path.join(box, "pid");
    const started = Date.now();

    await expect(
      runShell("/bin/sh", ["-c", `sleep 30 & echo $! > ${pid}; echo started; wait`], 500),
    ).rejects.toThrow("/bin/sh did not answer within 500ms");

    expect(Date.now() - started).toBeLessThan(2000);
    await expect.poll(() => alive(Number(readFileSync(pid, "utf-8")))).toBe(false);
    rmSync(box, { force: true, recursive: true });
  });

  it("rejects a shell that does not exist", async () => {
    await expect(runShell("/nonexistent/shell", ["-c", "true"], 5000)).rejects.toThrow(/ENOENT/u);
  });
});
