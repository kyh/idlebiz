import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_IDLE_TIMEOUT_MS } from "@repo/agent-driver/runner";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import { DEPLOY_TIMEOUT_MS } from "@/shared/tool-specs";

const scratch = mkdtempSync(path.join(tmpdir(), "idlebiz-deploy-"));
const bin = path.join(scratch, "bin");
const workspace = path.join(scratch, "workspace");
const seenFile = path.join(scratch, "seen.json");
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
const previous = { PATH: process.env.PATH, STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY };
process.env.IDLEBIZ_ROOT_DIR = path.join(scratch, "save");
const { deployToVercel, productionAlias } = await import("./deploy");

/** Stand in for `npx` on PATH: note how it was run and where, then run `body`. */
const fakeNpx = (body: string): void => {
  const script = [
    // not execPath: a shebang cannot hold a space, and a PATH search past a script that fails to start reaches the real npx
    "#!/usr/bin/env node",
    `require("node:fs").writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }));`,
    body,
  ].join("\n");
  writeFileSync(path.join(bin, "npx"), script, { mode: 0o755 });
};

const Seen = z.object({
  args: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
});
const seen = () => Seen.parse(parseJson(readFileSync(seenFile, "utf-8")));

const PRINTS_A_DEPLOY = `process.stderr.write("Vercel CLI 54.11.0\\nBuilding…\\n");
process.stdout.write("https://acme-abc123.vercel.app");`;

const deployUnbound = () =>
  deployToVercel({ binding: null, cwd: workspace, token: "vercel-token" });

beforeEach(() => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ""}`;
  process.env.STRIPE_SECRET_KEY = "sk_live_founder";
});

afterEach(() => {
  rmSync(workspace, { force: true, recursive: true });
  rmSync(seenFile, { force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

describe("deploying with the Vercel CLI", () => {
  it("answers well inside the run's idle watchdog, since the agent's call waits on it in silence", () => {
    expect(DEPLOY_TIMEOUT_MS * 2).toBeLessThanOrEqual(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it("runs a production deploy of the product's folder, into its bound project, and reads the URL", async () => {
    fakeNpx(PRINTS_A_DEPLOY);
    const result = await deployToVercel({
      binding: { projectId: "prj_1", projectName: "acme", teamId: "team_1" },
      cwd: workspace,
      token: "vercel-token",
    });

    expect(result).toEqual({
      ok: true,
      output: "Vercel CLI 54.11.0\nBuilding…\nhttps://acme-abc123.vercel.app",
      url: "https://acme-abc123.vercel.app",
    });
    const { args, env } = seen();
    expect(args).toEqual(["--yes", "vercel", "deploy", workspace, "--prod", "--yes"]);
    expect(env).toMatchObject({
      CI: "1",
      VERCEL_ORG_ID: "team_1",
      VERCEL_PROJECT_ID: "prj_1",
      VERCEL_TOKEN: "vercel-token",
    });
  });

  it("keeps the production domain the CLI prints on stderr", async () => {
    fakeNpx(`process.stderr.write("Building…\\n▲ Aliased         https://acme.vercel.app\\n");
process.stdout.write("https://acme-abc123.vercel.app");`);
    const result = await deployUnbound();

    expect(result).toMatchObject({ ok: true, url: "https://acme-abc123.vercel.app" });
    expect(result.output).toContain("▲ Aliased         https://acme.vercel.app");
    expect(productionAlias(result.output)).toBe("https://acme.vercel.app");
  });

  it("reads no production domain from a deploy that was not aliased", () => {
    expect(productionAlias("Vercel CLI 54.11.0\nhttps://acme-abc123.vercel.app")).toBeNull();
  });

  it("starts npx outside the product's folder, so a vercel the folder provides never runs", async () => {
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ bin: { vercel: "planted.js" }, name: "acme" }),
    );
    const planted = path.join(workspace, "node_modules", ".bin");
    mkdirSync(planted, { recursive: true });
    writeFileSync(path.join(planted, "vercel"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
    fakeNpx(PRINTS_A_DEPLOY);

    await expect(deployUnbound()).resolves.toMatchObject({ ok: true });
    const { args, cwd } = seen();
    // the fake reports where it runs as the OS resolves it, and tmpdir() can be a link
    expect(path.relative(realpathSync(workspace), cwd).startsWith("..")).toBe(true);
    expect(args.filter((arg) => path.isAbsolute(arg))).toEqual([workspace]);
  });

  it.each(["vercel.ts", "vercel.mts", "vercel.js", "vercel.mjs", "vercel.cjs"])(
    "never starts the CLI on a folder holding %s, which it would run with the key",
    async (config) => {
      writeFileSync(path.join(workspace, config), "export default {};\n");
      fakeNpx(PRINTS_A_DEPLOY);

      await expect(deployUnbound()).resolves.toEqual({
        ok: false,
        output: `The deploy was not started: the product's folder holds ${config}, which the Vercel CLI would run with the founder's key. Move that config into vercel.json, delete ${config}, then deploy again.`,
      });
      expect(existsSync(seenFile)).toBe(false);
    },
  );

  it("keeps the git the CLI runs in the product's folder from running what its repo names", async () => {
    const leak = path.join(scratch, "leak");
    const monitor = path.join(scratch, "fsmonitor");
    writeFileSync(monitor, `#!/bin/sh\necho "$VERCEL_TOKEN" > ${JSON.stringify(leak)}\n`, {
      mode: 0o755,
    });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: workspace,
        stdio: "ignore",
      });
    git("init", "-q");
    writeFileSync(path.join(workspace, "index.html"), "hi\n");
    git("add", "index.html");
    git("commit", "-qm", "ship");
    git("config", "core.fsmonitor", monitor);
    // what the CLI does for commit metadata
    fakeNpx(`require("node:child_process").spawnSync("git", ["--no-optional-locks", "status", "-s"], {
  cwd: process.argv.slice(2).find((arg) => arg.startsWith("/")),
});
${PRINTS_A_DEPLOY}`);

    await expect(deployUnbound()).resolves.toMatchObject({ ok: true });
    expect(existsSync(leak)).toBe(false);
  });

  it("hands the CLI none of main's other secrets, no relative PATH entry, and an unbound folder no project", async () => {
    process.env.PATH = [bin, "node_modules/.bin", ".", previous.PATH ?? ""].join(path.delimiter);
    fakeNpx(PRINTS_A_DEPLOY);
    await deployUnbound();

    const { env } = seen();
    expect(env).not.toHaveProperty("STRIPE_SECRET_KEY");
    expect(env).not.toHaveProperty("VERCEL_ORG_ID");
    expect(env).not.toHaveProperty("VERCEL_PROJECT_ID");
    const dirs = (env.PATH ?? "").split(path.delimiter);
    expect(dirs[0]).toBe(bin);
    expect(dirs.filter((dir) => !path.isAbsolute(dir))).toEqual([]);
  });

  it("answers a failed deploy with what the CLI printed", async () => {
    fakeNpx(`process.stderr.write("Error: Command \\"npm run build\\" exited with 1\\n");
process.exit(1);`);
    await expect(deployUnbound()).resolves.toEqual({
      ok: false,
      output: 'Error: Command "npm run build" exited with 1',
    });
  });

  it("counts a deploy that printed no URL as failed", async () => {
    fakeNpx(`process.stderr.write("Linked to acme\\n");`);
    await expect(deployUnbound()).resolves.toEqual({ ok: false, output: "Linked to acme" });
  });
});
