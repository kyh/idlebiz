import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefusalError } from "../refusal";
import { TOOL_NAMES, curlOf } from "../tool-specs";
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
  let managed = "";

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-denies-"));
    managed = path.join(base, "managed-settings.json");
  });

  afterEach(() => {
    rmSync(base, { force: true, recursive: true });
  });

  it("refuses a run whose managed settings deny the curl every company tool is called with", async () => {
    settle(managed, ["Read(./.env)", "Bash(curl:*)"]);
    const refused = refuseDeniedTools(managed);
    await expect(refused).rejects.toBeInstanceOf(RefusalError);
    await expect(refused).rejects.toThrow(`Bash(curl:*)`);
    await expect(refused).rejects.toThrow(managed);
  });

  it("lets a run start past rules that leave curl alone, and settings it cannot read", async () => {
    settle(managed, ["Bash(rm:*)", "WebFetch"]);
    await expect(refuseDeniedTools(managed)).resolves.toBeUndefined();
    writeFileSync(managed, JSON.stringify({ permissions: { deny: "Bash" } }));
    await expect(refuseDeniedTools(managed)).resolves.toBeUndefined();
    await expect(refuseDeniedTools(path.join(base, "none.json"))).resolves.toBeUndefined();
  });
});
