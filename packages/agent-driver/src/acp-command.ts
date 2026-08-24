import { createRequire } from "node:module";

/**
 * Argv for a bundled ACP agent adapter.
 *
 * The adapters ship as real dependencies rather than being fetched with `npx`
 * at run time: a packaged desktop app cannot rely on the user having a network
 * or a working npm when an employee wakes up. Resolving the installed entry
 * point also pins the version to the lockfile instead of whatever the registry
 * serves that day.
 */
export function acpAgentCommand(packageName: string, binName: string): readonly string[] {
  const require = createRequire(import.meta.url);
  try {
    return [process.execPath, require.resolve(`${packageName}/dist/index.js`)];
  } catch {
    // Not installed (a source checkout, or a build that pruned it) — fall back
    // to whatever is on PATH so a dev machine still runs.
    return [binName];
  }
}
