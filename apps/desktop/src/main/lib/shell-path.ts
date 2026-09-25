import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SANDBOX_EXEC, sealedCommand } from "@/main/agents/seal";
import type { Seal } from "@/main/agents/seal";

// Finder's PATH omits CLI install locations. Prefer the login shell's PATH,
// with known directories as fallback when shell startup fails or times out.
// The shell runs the founder's startup files and all they source, any of which a run could
// have written, so it runs sealed as a run would, holding neither runner's login.

const SHELL_TIMEOUT_MS = 5000;
const MARK = "__IDLEBIZ_PATH__";

const knownBinDirs = (): string[] => {
  const home = homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
};

const execFileAsync = promisify(execFile);

const loginShellPath = async (seal: Seal): Promise<string | null> => {
  const shell = process.env.SHELL ?? "/bin/zsh";
  const [bin = SANDBOX_EXEC, ...args] = sealedCommand(seal, "shell", [
    shell,
    "-ilc",
    `printf '%s' "${MARK}\${PATH}${MARK}"`,
  ]);
  try {
    const { stdout } = await execFileAsync(bin, args, {
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
      timeout: SHELL_TIMEOUT_MS,
    });
    const [, found] = stdout.split(MARK);
    return found && found.length > 0 ? found : null;
  } catch {
    return null;
  }
};

const dedupe = (parts: readonly string[]): string[] => [
  ...new Set(parts.filter((dir) => dir.length > 0)),
];

/**
 * Take the login shell's PATH as main's, its startup run under `seal`. The shell's folders stay
 * whether they exist yet or not: the founder's terminal runs from them, so a run must not be the
 * one to make them, and every run's seal keeps what is on main's PATH.
 */
export const adoptShellPath = async (seal: Seal): Promise<void> => {
  const current = (process.env.PATH ?? "").split(path.delimiter);
  const shell = ((await loginShellPath(seal)) ?? "").split(path.delimiter);
  const fallback = [...knownBinDirs(), ...current].filter((dir) => existsSync(dir));
  process.env.PATH = dedupe([...shell, ...fallback]).join(path.delimiter);
};
