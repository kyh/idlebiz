import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPageServer } from "../page-server";
import { RefusalError } from "../refusal";
import { tempSave } from "../test-support/save";
import { sandboxOf, sandboxRuns } from "./sandbox";

const root = tempSave();

const onMac = process.platform === "darwin";

// each check starts real sandboxed processes, which take seconds each on a CI runner
vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!onMac)("sandboxRuns", () => {
  let box = "";
  const touched = ["HOME", "PATH", "CLAUDE_BIN", "CODEX_BIN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-home-")));
    process.env.PATH = path.join(box, "no-bin");
    process.env.HOME = path.join(box, "home");
    mkdirSync(path.join(box, "home"));
    for (const key of ["CLAUDE_BIN", "CODEX_BIN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(box, { force: true, recursive: true });
  });

  it("sandboxes this machine's runs with its home, its temp folders and the save, each where it resolves", async () => {
    const home = path.join(box, "home");
    mkdirSync(path.join(box, "dotfiles/claude"), { recursive: true });
    symlinkSync(path.join(box, "dotfiles/claude"), path.join(home, ".claude"));
    expect(await sandboxRuns()).toEqual({ kind: "sandboxed" });
    const sandbox = await sandboxOf([path.join(root, "company/products/ledger/workspace")]);
    expect(sandbox.runners.claude.home).toEqual([
      { match: "subpath", path: path.join(home, ".claude") },
      { match: "subpath", path: path.join(box, "dotfiles/claude") },
    ]);
    expect(sandbox.runners.claude.state).toContainEqual({
      match: "subpath",
      path: path.join(box, "dotfiles/claude/sessions"),
    });
    expect(sandbox.runners.claude.account).toEqual([
      { match: "prefix", path: path.join(home, ".claude/.claude.json") },
      { match: "prefix", path: path.join(box, "dotfiles/claude/.claude.json") },
      { match: "prefix", path: path.join(home, ".claude.json") },
    ]);
    expect(sandbox.unreadable).toContainEqual({
      match: "prefix",
      path: path.join(realpathSync(root), "vault.json"),
    });
    expect(sandbox.scratch).toEqual(
      expect.arrayContaining([
        { match: "subpath", path: "/private/tmp" },
        { match: "subpath", path: realpathSync(tmpdir()) },
      ]),
    );
    expect(sandbox.writable).toEqual([
      {
        match: "subpath",
        path: path.join(realpathSync(root), "company/products/ledger/workspace"),
      },
    ]);
    expect(sandbox.skillFolders).toEqual([
      {
        match: "subpath",
        path: path.join(realpathSync(root), "company/products/ledger/workspace/.agents"),
      },
    ]);
    expect(sandbox.runners.codex.personal).toEqual([
      { match: "subpath", path: path.join(home, ".codex/skills") },
      { match: "subpath", path: path.join(home, ".codex/AGENTS.md") },
      { match: "subpath", path: path.join(home, ".codex/AGENTS.override.md") },
      { match: "subpath", path: path.join(home, ".codex/memories") },
      { match: "subpath", path: path.join(home, ".agents/skills") },
    ]);
    expect(sandbox.runners.claude.personal).toEqual([]);
    expect(sandbox.runners.codex.absent).toEqual([
      { match: "subpath", path: path.join(home, ".codex/rules") },
    ]);
    expect(sandbox.runners.claude.absent).toEqual([]);
    expect(sandbox.closedPorts).toEqual([9222, 9229, 31_100]);
    expect(sandbox.sockets).toEqual(
      expect.arrayContaining(
        [
          "/private/tmp/cc-socks",
          "/private/tmp/codex-browser-use",
          "/private/tmp/com.openai.sky.CUAService",
        ].map((at) => ({ match: "subpath", path: at })),
      ),
    );
  });

  it("refuses a run whose folder lies outside the save in words the founder reads", async () => {
    const elsewhere = path.join(box, "elsewhere");
    await expect(sandboxOf([elsewhere])).rejects.toThrow(
      new RefusalError(
        `${elsewhere} is no folder inside the save, so IdleBiz starts no run that writes it.`,
      ),
    );
  });

  it("closes the port main serves the window's page on, while it answers", async () => {
    const page = await startPageServer({
      handleRpc: () => Promise.resolve(false),
      page: { kind: "dev", origin: "http://localhost:1" },
    });
    try {
      const sandbox = await sandboxOf([]);
      expect(sandbox.closedPorts).toEqual([9222, 9229, 31_100, page.port]);
    } finally {
      await page.stop();
    }
    const after = await sandboxOf([]);
    expect(after.closedPorts).toEqual([9222, 9229, 31_100]);
  });

  it("finds a runner's home where the founder moved it, and keeps the one in HOME theirs", async () => {
    const moved = path.join(box, "codex-home");
    process.env.CODEX_HOME = moved;
    const sandbox = await sandboxOf([]);
    expect(sandbox.runners.codex.home).toEqual([
      { match: "subpath", path: moved },
      { match: "subpath", path: path.join(box, "home", ".codex") },
    ]);
    expect(sandbox.runners.codex.state).toContainEqual({
      match: "prefix",
      path: path.join(moved, "auth.json"),
    });
  });

  it("keeps the PATH folders that lie in a folder a run writes, and only those", async () => {
    const shims = path.join(box, "shims");
    mkdirSync(shims);
    process.env.PATH = [shims, "/usr/bin", "node_modules/.bin"].join(path.delimiter);
    const { runsAsFounder } = await sandboxOf([]);
    const kept = runsAsFounder.map(({ path: at }) => at);
    expect(kept).toContain(shims);
    expect(kept).toContain(path.join(realpathSync(tmpdir()), "cmux-cli-shims"));
    expect(kept).not.toContain("/usr/bin");
    expect(kept).not.toContain("node_modules/.bin");
  });

  it("resolves the home as it stands each time, so a login linked away since is sandboxed where it leads", async () => {
    const home = path.join(box, "home");
    const away = path.join(box, "external/aws");
    mkdirSync(away, { recursive: true });
    const before = await sandboxOf([]);
    symlinkSync(away, path.join(home, ".aws"));
    const after = await sandboxOf([]);
    expect(before.unreadable).not.toContainEqual({ match: "subpath", path: away });
    expect(after.unreadable).toContainEqual({ match: "subpath", path: away });
  });
});
