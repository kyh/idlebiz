import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathWithLauncher, writeAgentLauncher } from "./agent-launcher";

const execFileAsync = promisify(execFile);

describe("the launcher a run calls idlebiz through", () => {
  let base = "";

  beforeEach(() => {
    // a folder whose name a shell would split and unquote, as an app moved somewhere odd might
    base = mkdtempSync(path.join(tmpdir(), "idlebiz launcher's $HOME "));
  });

  afterEach(() => {
    rmSync(base, { force: true, recursive: true });
  });

  it("runs the CLI on main's node, handing it every word as typed", async () => {
    const cli = path.join(base, "cli's entry.mjs");
    writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const bin = path.join(base, "bin");
    writeAgentLauncher(bin, process.execPath, cli);
    // run as a program, so it is one
    const { stdout } = await execFileAsync(path.join(bin, "idlebiz"), [
      "ask-boss",
      `{"question":"Can't we ship?"}`,
      "$HOME",
    ]);
    expect(JSON.parse(stdout)).toEqual(["ask-boss", `{"question":"Can't we ship?"}`, "$HOME"]);
  });

  it("is rewritten whole at each boot, for an app that moved", async () => {
    const bin = path.join(base, "bin");
    const first = path.join(base, "first.mjs");
    const moved = path.join(base, "moved.mjs");
    writeFileSync(first, 'process.stdout.write("first");\n');
    writeFileSync(moved, 'process.stdout.write("moved");\n');
    writeAgentLauncher(bin, process.execPath, first);
    writeAgentLauncher(bin, process.execPath, moved);
    const { stdout } = await execFileAsync(path.join(bin, "idlebiz"));
    expect(stdout).toBe("moved");
  });

  it("goes first on a run's PATH", () => {
    expect(pathWithLauncher("/save/bin", "/usr/bin:/bin")).toBe(
      `/save/bin${path.delimiter}/usr/bin:/bin`,
    );
    expect(pathWithLauncher("/save/bin")).toBe("/save/bin");
    expect(pathWithLauncher("/save/bin", "")).toBe("/save/bin");
  });
});
