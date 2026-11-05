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
import { machineSeal, realPathOf, sealFor } from "../agents/machine-seal";
import { inside, sealedCommand } from "../agents/seal";
import { runnerEnv } from "../agents/session";
import { tempSave } from "./save";
import { startStandInModel } from "./stand-in-model";
import type { StandInModel } from "./stand-in-model";
import { bundledCli, isProviderEnv, standInRunnerEnv } from "./stand-in-runners";

// The CLIs the adapters bundle, signed in to the stand-in model, as main's own probe finds them at
// boot: as they are everywhere, and on a Mac under each runner's seal too, as boot starts them. The
// probe's env is main's (`runnerEnv`), so this also holds that a run keeps the stand-in's key,
// though its name is a credential's.

// the seal reads where the save is
tempSave();

/**
 * Main's env holding `env`, with HOME at `home` and none of this machine's own provider env, so
 * the stand-in's login is the only one a CLI could find.
 */
const asMainWith = (env: Readonly<Record<string, string>>, home: string): void => {
  for (const name of Object.keys(process.env)) {
    if (isProviderEnv(name) && !(name in env)) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- vi.stubEnv unsets a name only when handed undefined
      vi.stubEnv(name, undefined);
    }
  }
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("HOME", home);
};

const asItIs = (_runner: RunnerId, argv: Argv): Argv => argv;

/** Whether `probes` found each of `runners` installed and signed in. */
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
    "signs both in under each runner's seal, as boot looks for them",
    { timeout: 90_000 },
    async () => {
      const env = await standInRunnerEnv({
        model,
        runners: ["claude", "codex"],
        scratch: path.join(scratch, "sealed"),
      });
      asMainWith(env, home);
      const seal = await machineSeal([]);
      const probes = await probeRunners(runnerEnv, (runner, argv) =>
        sealedCommand(seal, runner, argv),
      );
      expect(readiness(probes)).toEqual([
        { authed: true, id: "claude", installed: true },
        { authed: true, id: "codex", installed: true },
      ]);
      expect(model.leaks).toEqual([]);
    },
  );

  it("leaves the signed-in runner's home writable by its runs, though the seal keeps the absent CLI's folder", async () => {
    const left = path.join(scratch, "claude-alone");
    const env = await standInRunnerEnv({ model, runners: ["claude"], scratch: left });
    const claudeHome = env.CLAUDE_CONFIG_DIR ?? "";
    const seal = await sealFor({
      clis: [env.CLAUDE_BIN ?? "", env.CODEX_BIN ?? ""],
      closedPorts: [],
      env,
      home,
      mainOnly: [],
      pathDirs: [],
      save: path.join(scratch, "save"),
      // the homes sit in TMPDIR, which every run writes
      scratch: [tmpdir()],
      shims: [],
      sshAgent: null,
      writable: [],
    });
    const homes = [claudeHome, await realPathOf(claudeHome)];
    const keptOverHome = seal.runsAsFounder.filter(({ path: kept }) =>
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
