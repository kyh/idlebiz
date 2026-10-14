import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Seal } from "./seal";
import { acpAgentFor } from "./session";
import { machineSeal } from "./machine-seal";
import { sealedCommand } from "./seal";
import { toolCacheDir } from "../paths";
import { tempSave } from "../test-support/save";

// The real agent-browser, driven as a run drives it: under the run's seal, in its env, from its
// working directory. It proves a screenshot named no path lands where a run writes, and that a
// daemon a run left idling never serves a run with other folders, where it would write into the
// first run's workspace.

const root = tempSave();

const browserRuns =
  process.platform === "darwin" && spawnSync("agent-browser", ["--version"]).status === 0;

const SESSION = "mae";

/** Everything each test's runs opened, closed once all are done. */
const opened: { seal: Seal; cwd: string }[] = [];

/** `args` as agent-browser runs them in a claude run under `seal`, from `cwd`. */
const browse = (seal: Seal, cwd: string, ...args: string[]) => {
  const [bin = "", ...rest] = sealedCommand(seal, "claude", [
    "agent-browser",
    "--session",
    SESSION,
    ...args,
  ]);
  const { output, status } = spawnSync(bin, rest, {
    cwd,
    encoding: "utf-8",
    env: acpAgentFor("claude", seal, { skills: root, teamNotes: null, userSettings: {} }).env,
    timeout: 45_000,
  });
  return { output: output.join(""), status };
};

/** A run's seal, with its folders and daemon namespace made as main makes them before it starts. */
const runIn = async (name: string) => {
  const workspace = path.join(root, name);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(toolCacheDir(), "tmp"), { recursive: true });
  const seal = await machineSeal([workspace, toolCacheDir()]);
  mkdirSync(seal.namespaces.claude.path, { recursive: true });
  opened.push({ cwd: workspace, seal });
  return { seal, workspace };
};

describe.skipIf(!browserRuns)("agent-browser inside the seal", () => {
  // every daemon closed before any namespace goes: a close with no daemon there starts one. On a
  // busy machine (`pnpm test` compiling the shell beside it) the closes outlast a hook's 10s.
  afterAll(() => {
    for (const { cwd, seal } of opened) {
      browse(seal, cwd, "close");
    }
    for (const { seal } of opened) {
      rmSync(seal.namespaces.claude.path, { force: true, recursive: true });
    }
  }, 90_000);

  it(
    "saves a screenshot named no path where the run can read it",
    { timeout: 90_000 },
    async () => {
      const { seal, workspace } = await runIn("solo");
      expect(browse(seal, workspace, "open", "about:blank").status).toBe(0);
      const shot = browse(seal, workspace, "screenshot");
      expect(shot.output).not.toMatch(/not permitted/iu);
      expect(shot.status).toBe(0);
      expect(readdirSync(path.join(toolCacheDir(), "tmp", "screenshots"))).toHaveLength(1);
    },
  );

  it(
    "never lends a daemon one run started to a run with other folders",
    { timeout: 90_000 },
    async () => {
      const first = await runIn("product-a");
      const second = await runIn("product-b");
      expect(browse(first.seal, first.workspace, "open", "about:blank").status).toBe(0);
      expect(browse(second.seal, second.workspace, "open", "about:blank").status).toBe(0);
      expect(browse(second.seal, second.workspace, "screenshot", "shot.png").status).toBe(0);
      expect(existsSync(path.join(second.workspace, "shot.png"))).toBe(true);
      expect(existsSync(path.join(first.workspace, "shot.png"))).toBe(false);
    },
  );
});
