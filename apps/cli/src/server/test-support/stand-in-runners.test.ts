import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeRunners } from "@repo/agent-driver/detect";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import type { Argv } from "@repo/agent-driver/registry";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { realPathOf, sandboxFor } from "@repo/sandbox/machine";
import { inside, sandboxedCommand } from "@repo/sandbox/profile";
import { sandboxOf } from "../agents/sandbox";
import { runnerEnv } from "../agents/session";
import { tempSave } from "./save";
import { startStandInModel } from "./stand-in-model";
import type { StandInModel } from "./stand-in-model";
import { bundledCli, isProviderEnv, standInRunnerEnv } from "./stand-in-runners";

tempSave();

const asMainWith = (env: Readonly<Record<string, string>>, home: string) => {
  for (const name of Object.keys(process.env)) {
    if (isProviderEnv(name) && !(name in env)) {
      vi.stubEnv(name, undefined);
    }
  }

  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }

  vi.stubEnv("HOME", home);
};

const asItIs = (_runner: RunnerId, argv: Argv) => argv;

const readiness = (probes: readonly RunnerProbe[]) =>
  probes.map((probe) => ({
    authed: probe.installed && probe.authed,
    id: probe.id,
    installed: probe.installed,
  }));

describe("the CLIs the adapters bundle, on the stand-in", () => {
  let model: StandInModel;
  let scratch = "";
  let home = "";

  beforeAll(async () => {
    model = await startStandInModel();
    scratch = await mkdtemp(path.join(tmpdir(), "idlebiz-stand-in-runners-"));
    home = path.join(scratch, "home");
    await mkdir(home);
  });

  afterAll(async () => {
    await model.close();
    await rm(scratch, { force: true, recursive: true });
  });

  it("finds each CLI where its adapter would", async () => {
    for (const runner of RUNNER_IDS) {
      await expect(access(bundledCli(runner), constants.X_OK)).resolves.toBeUndefined();
    }
  });

  it("signs both in to the stand-in, as main's probe reads them", { timeout: 90_000 }, async () => {
    const env = await standInRunnerEnv({
      model,
      runners: ["claude", "codex"],
      scratch: path.join(scratch, "both"),
    });

    asMainWith(env, home);
    const probes = await probeRunners(runnerEnv, asItIs);
    expect(readiness(probes)).toEqual([
      { authed: true, id: "claude", installed: true },
      { authed: true, id: "codex", installed: true },
    ]);
    expect(probes.map(({ bin }) => bin)).toEqual([bundledCli("claude"), bundledCli("codex")]);
    expect(model.leaks).toEqual([]);
    expect(model.unexpected).toEqual([]);
  });

  it.runIf(process.platform === "darwin")(
    "signs both in under each runner's sandbox, as boot looks for them",
    { timeout: 90_000 },
    async () => {
      const env = await standInRunnerEnv({
        model,
        runners: ["claude", "codex"],
        scratch: path.join(scratch, "sandboxed"),
      });

      asMainWith(env, home);
      const sandbox = await sandboxOf([]);

      const probes = await probeRunners(runnerEnv, (runner, argv) =>
        sandboxedCommand(sandbox, runner, argv),
      );

      expect(readiness(probes)).toEqual([
        { authed: true, id: "claude", installed: true },
        { authed: true, id: "codex", installed: true },
      ]);
      expect(model.leaks).toEqual([]);
    },
  );

  it("leaves the signed-in runner's home writable by its runs, though the sandbox keeps the absent CLI's folder", async () => {
    const left = path.join(scratch, "claude-alone");
    const env = await standInRunnerEnv({ model, runners: ["claude"], scratch: left });
    const claudeHome = env.CLAUDE_CONFIG_DIR ?? "";

    const sandbox = await sandboxFor({
      clis: [env.CLAUDE_BIN ?? "", env.CODEX_BIN ?? ""],
      closedPorts: [],
      env,
      home,
      hostOnly: [],
      pathDirs: [],
      save: path.join(scratch, "save"),
      scratch: [tmpdir()],
      shims: [],
      sshAgent: null,
      writable: [],
    });

    const homes = [claudeHome, await realPathOf(claudeHome)];

    const keptOverHome = sandbox.runsAsFounder.filter(({ path: kept }) =>
      homes.some((at) => inside(kept, at)),
    );

    expect(keptOverHome).toEqual([]);
  });

  it("points a runner it was not asked for at nothing, so no CLI of this machine's is looked for", async () => {
    const left = path.join(scratch, "claude-only");
    const env = await standInRunnerEnv({ model, runners: ["claude"], scratch: left });
    expect(env.CODEX_BIN).toBe(path.join(left, "absent", "no-codex"));
    expect(env.CODEX_HOME).toBeUndefined();
    asMainWith(env, home);
    const probes = await probeRunners(runnerEnv, asItIs);
    expect(readiness(probes)).toEqual([
      { authed: true, id: "claude", installed: true },
      { authed: false, id: "codex", installed: false },
    ]);
  });
});
