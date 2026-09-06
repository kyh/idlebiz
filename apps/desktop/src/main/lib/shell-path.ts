import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// ---------------------------------------------------------------------------
// The PATH the founder's terminal has, for an app the founder launched from
// Finder. launchd hands a GUI app /usr/bin:/bin:/usr/sbin:/sbin — none of
// ~/.local/bin, Homebrew, nvm, volta or bun, which is where coding CLIs live.
// So `claude` and `codex` read as "not installed" and the app starts an install
// nobody asked for. VS Code, Cursor and every Electron app that shells out
// solve this the same way: ask the login shell for its environment once, at
// boot, and adopt its PATH. The known install dirs are the net under that,
// for a shell whose rc files fail or take too long.
// ---------------------------------------------------------------------------

const SHELL_TIMEOUT_MS = 5_000;
const MARK = "__IDLEBIZ_PATH__";

/** Where the CLIs land on a Mac, whatever the shell says. */
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

/** `$PATH` as the founder's interactive login shell sets it, or null if it will not say. */
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

/** Every directory in `parts`, first occurrence wins, only ones that exist. */
function dedupe(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of parts) {
    if (dir.length > 0 && !out.includes(dir) && existsSync(dir)) out.push(dir);
  }
  return out;
}

/**
 * Widen this process's PATH to what the founder's shell has, plus the known
 * install dirs. Children inherit process.env, so every CLI probe and every
 * agent run resolves `claude` and `codex` the way the founder's terminal does.
 */
export async function adoptShellPath(): Promise<void> {
  const current = (process.env["PATH"] ?? "").split(delimiter);
  const shell = ((await loginShellPath()) ?? "").split(delimiter);
  process.env["PATH"] = dedupe([...shell, ...knownBinDirs(), ...current]).join(delimiter);
}
