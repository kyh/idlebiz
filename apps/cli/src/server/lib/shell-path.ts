import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { report } from "./report";

// Finder's PATH omits CLI install locations. The packaged app prefers the login shell's PATH,
// with known directories until it answers, and in its place when shell startup fails or times out.

const SHELL_TIMEOUT_MS = 5000;
const DEFAULT_SHELL = "/bin/zsh";
// rc files print banners, motds and prompts to stdout; only what sits between the markers is the PATH
const MARK = "__IDLEBIZ_PATH__";
// printenv reads the exported variable, so fish's list-valued PATH is colon-joined like everyone else's
const PRINT_PATH = `echo ${MARK}; /usr/bin/printenv PATH; echo ${MARK}`;

// Kept whether it exists yet or not: onboarding's Claude Code installer makes it, and the CLI
// it installs must be found without a restart.
const installerBinDir = (): string => path.join(homedir(), ".local", "bin");

const knownBinDirs = (): string[] => {
  const home = homedir();
  return [
    path.join(home, ".claude", "local"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
};

const markedPath = (stdout: string): string | null => {
  const parts = stdout.split(MARK);
  if (parts.length < 3) {
    return null;
  }
  const printed = parts[1]?.trim() ?? "";
  return printed === "" ? null : printed;
};

// the group, since what hangs is usually a command the rc file ran; SIGKILL, since an
// interactive shell ignores SIGTERM
const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
};

/**
 * What `shell` printed, once it printed the second marker or exited; it and whatever it started
 * are killed then, at `timeoutMs`, or as main exits. Detached: its own process group, and no
 * terminal an interactive shell could take. Its stdin is empty, so an rc file that reads it reads
 * nothing, and a daemon an rc file starts can hold stdout open after the shell is gone, which is
 * why the marker, not stdout's close, ends the wait.
 */
export const runShell = async (
  shell: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> => {
  const child = spawn(shell, args, {
    detached: true,
    // oh-my-zsh otherwise checks for its own update over the network inside the budget
    env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stop = (): void => {
    child.stdout.destroy();
    killGroup(child.pid);
  };
  process.once("exit", stop);
  let stdout = "";
  child.stdout.setEncoding("utf-8");
  const marked = Promise.withResolvers<"marked">();
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (markedPath(stdout) !== null) {
      marked.resolve("marked");
    }
  });
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    await Promise.race([marked.promise, once(child, "close", { signal: deadline })]);
  } catch (error) {
    if (!deadline.aborted) {
      throw error;
    }
    throw new Error(`${shell} did not answer within ${String(timeoutMs)}ms`, { cause: error });
  } finally {
    process.off("exit", stop);
    stop();
  }
  return stdout;
};

// absolute or nothing: a bare name would be looked up on the very PATH this is fixing
const loginShell = (): string => {
  const configured = process.env.SHELL;
  return configured !== undefined && path.isAbsolute(configured) ? configured : DEFAULT_SHELL;
};

const loginShellPath = async (): Promise<string | null> => {
  const shell = loginShell();
  try {
    const printed = markedPath(await runShell(shell, ["-ilc", PRINT_PATH], SHELL_TIMEOUT_MS));
    if (printed === null) {
      report("shell path", `${shell} printed no PATH`);
    }
    return printed;
  } catch (error) {
    report("shell path", error);
    return null;
  }
};

const joined = (parts: readonly string[]): string =>
  [...new Set(parts.filter((dir) => dir.length > 0))].join(path.delimiter);

/**
 * Put the founder's CLIs on main's PATH. A development launch comes from a terminal whose PATH is
 * already the founder's, and may be ordered on purpose, so it keeps it. The packaged app starts
 * with launchd's: it takes the known folders that exist at once, and the login shell's PATH ahead
 * of them when the shell answers, which settles this within the shell's deadline whatever its
 * startup files do. The shell's folders, and the one onboarding installs Claude Code into, stay
 * whether they exist yet or not: the founder's terminal runs from them, so a run must not be the
 * one to make one inside a folder it writes, and every run's seal keeps what is on main's PATH.
 */
export const adoptShellPath = async (packaged: boolean): Promise<void> => {
  const current = (process.env.PATH ?? "").split(path.delimiter);
  if (!packaged) {
    process.env.PATH = joined([...current, installerBinDir()]);
    return;
  }
  const fallback = [
    installerBinDir(),
    ...[...knownBinDirs(), ...current].filter((dir) => existsSync(dir)),
  ];
  process.env.PATH = joined(fallback);
  const shell = await loginShellPath();
  if (shell !== null) {
    process.env.PATH = joined([...shell.split(path.delimiter), ...fallback]);
  }
};
