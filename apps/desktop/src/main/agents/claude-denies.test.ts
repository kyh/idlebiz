import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefusalError } from "@/shared/refusal";
import { TOOL_NAMES, curlOf } from "@/shared/tool-specs";
import { deniesCommand, refuseDeniedTools } from "./claude-denies";

const MESSAGE_TEAM = curlOf("message_team");

const settle = (file: string, deny: readonly string[]): void => {
  writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash"], deny } }));
};

describe("deniesCommand", () => {
  it.each(["Bash", "Bash(*)", "Bash(curl:*)", "Bash(curl *)", "Bash(curl*)", "Bash(*POST*)"])(
    "reads %s as denying a company tool's curl",
    (rule) => {
      expect(deniesCommand(rule, MESSAGE_TEAM)).toBe(true);
    },
  );

  it.each([
    "Bash(curl)",
    "Bash(rm:*)",
    "Bash(curl https://*)",
    "Read(./.env)",
    "WebFetch",
    "mcp__*",
    "Bash(git push:*)",
  ])("leaves a company tool's curl to %s", (rule) => {
    expect(deniesCommand(rule, MESSAGE_TEAM)).toBe(false);
  });

  it("matches a pattern's other characters literally", () => {
    expect(deniesCommand("Bash(curl -s.*)", MESSAGE_TEAM)).toBe(false);
    expect(deniesCommand('Bash(curl -s -X POST "$IDLEBIZ_API_URL/v1/*)', MESSAGE_TEAM)).toBe(true);
  });

  it("knows every tool's taught curl", () => {
    expect(TOOL_NAMES.map(curlOf).every((command) => deniesCommand("Bash(curl:*)", command))).toBe(
      true,
    );
  });
});

describe("refuseDeniedTools", () => {
  let base = "";
  let configDir = "";
  let cwd = "";

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-denies-"));
    configDir = path.join(base, "config");
    cwd = path.join(base, "workspace");
    mkdirSync(configDir);
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { force: true, recursive: true });
  });

  it("refuses a run whose founder settings deny the curl every company tool is called with", async () => {
    const settings = path.join(configDir, "settings.json");
    settle(settings, ["Read(./.env)", "Bash(curl:*)"]);
    const refused = refuseDeniedTools(configDir, cwd);
    await expect(refused).rejects.toBeInstanceOf(RefusalError);
    await expect(refused).rejects.toThrow(`Bash(curl:*)`);
    await expect(refused).rejects.toThrow(settings);
  });

  it("reads the project's own settings too", async () => {
    settle(path.join(cwd, ".claude", "settings.local.json"), ["Bash"]);
    await expect(refuseDeniedTools(configDir, cwd)).rejects.toThrow("Bash");
  });

  it("lets a run start past rules that leave curl alone, and settings it cannot read", async () => {
    settle(path.join(configDir, "settings.json"), ["Bash(rm:*)", "WebFetch"]);
    writeFileSync(path.join(cwd, ".claude", "settings.json"), "{ not json");
    writeFileSync(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { deny: "Bash" } }),
    );
    await expect(refuseDeniedTools(configDir, cwd)).resolves.toBeUndefined();
  });
});
