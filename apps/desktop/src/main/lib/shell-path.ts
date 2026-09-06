import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Finder's PATH omits CLI install locations. Prefer the login shell's PATH,
// with known directories as fallback when shell startup fails or times out.

const SHELL_TIMEOUT_MS = 5_000;
const MARK = "__IDLEBIZ_PATH__";

function knownBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

function loginShellPath(): Promise<string | null> {
  const shell = process.env["SHELL"] || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s' "${MARK}\${PATH}${MARK}"`],
      { timeout: SHELL_TIMEOUT_MS, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const found = stdout.split(MARK)[1];
        resolve(found && found.length > 0 ? found : null);
      },
    );
  });
}

function dedupe(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of parts) {
    if (dir.length > 0 && !out.includes(dir) && existsSync(dir)) out.push(dir);
  }
  return out;
}

export async function adoptShellPath(): Promise<void> {
  const current = (process.env["PATH"] ?? "").split(delimiter);
  const shell = ((await loginShellPath()) ?? "").split(delimiter);
  process.env["PATH"] = dedupe([...shell, ...knownBinDirs(), ...current]).join(delimiter);
}
