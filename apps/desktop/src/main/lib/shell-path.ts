import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Finder's PATH omits CLI install locations. Prefer the login shell's PATH,
// with known directories as fallback when shell startup fails or times out.

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

const loginShellPath = async (): Promise<string | null> => {
  const shell = process.env.SHELL ?? "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(
      shell,
      ["-ilc", `printf '%s' "${MARK}\${PATH}${MARK}"`],
      {
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
        timeout: SHELL_TIMEOUT_MS,
      },
    );
    const [, found] = stdout.split(MARK);
    return found && found.length > 0 ? found : null;
  } catch {
    return null;
  }
};

const dedupe = (parts: readonly string[]): string[] => {
  const out: string[] = [];
  for (const dir of parts) {
    if (dir.length > 0 && !out.includes(dir) && existsSync(dir)) {
      out.push(dir);
    }
  }
  return out;
};

export const adoptShellPath = async (): Promise<void> => {
  const current = (process.env.PATH ?? "").split(path.delimiter);
  const shell = ((await loginShellPath()) ?? "").split(path.delimiter);
  process.env.PATH = dedupe([...shell, ...knownBinDirs(), ...current]).join(path.delimiter);
};
