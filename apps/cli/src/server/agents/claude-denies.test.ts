import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefusalError } from "../refusal";
import { TOOL_NAMES, commandOf } from "../tool-specs";
import { deniesCommand, refuseDeniedTools } from "./claude-denies";

const MESSAGE_TEAM = commandOf("message_team");

const settle = (file: string, deny: readonly string[]): void => {
  writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash"], deny } }));
};

describe("deniesCommand", () => {
  it.each([
    "Bash",
    "Bash(*)",
    "Bash(idlebiz:*)",
    "Bash(idlebiz *)",
    "Bash(idlebiz*)",
    "Bash(*team*)",
  ])("reads %s as denying a company tool's command", (rule) => {
    expect(deniesCommand(rule, MESSAGE_TEAM)).toBe(true);
  });

  it.each([
    "Bash(idlebiz)",
    "Bash(curl:*)",
    "Bash(rm:*)",
    "Bash(idlebiz serve:*)",
    "Read(./.env)",
    "WebFetch",
    "mcp__*",
    "Bash(git push:*)",
  ])("leaves a company tool's command to %s", (rule) => {
    expect(deniesCommand(rule, MESSAGE_TEAM)).toBe(false);
  });

  it("matches a pattern's other characters literally", () => {
    expect(deniesCommand("Bash(idlebiz message-team.*)", MESSAGE_TEAM)).toBe(false);
    expect(deniesCommand("Bash(idlebiz message-team '{*)", MESSAGE_TEAM)).toBe(true);
  });

  it("knows every tool's taught command", () => {
    expect(
      TOOL_NAMES.map(commandOf).every((command) => deniesCommand("Bash(idlebiz:*)", command)),
    ).toBe(true);
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

  it("refuses a run whose managed settings deny the command every company tool is called with", async () => {
    settle(managed, ["Read(./.env)", "Bash(idlebiz:*)"]);
    const refused = refuseDeniedTools(base);
    await expect(refused).rejects.toBeInstanceOf(RefusalError);
    await expect(refused).rejects.toThrow(`Bash(idlebiz:*)`);
    await expect(refused).rejects.toThrow(managed);
  });

  it("reads the drop-ins beside the file as the same source, as claude merges them", async () => {
    const dropIns = path.join(base, "managed-settings.d");
    mkdirSync(dropIns);
    settle(managed, ["Bash(rm:*)"]);
    settle(path.join(dropIns, "10-telemetry.json"), ["WebFetch"]);
    settle(path.join(dropIns, ".20-hidden.json"), ["Bash"]);
    settle(path.join(dropIns, "30-draft.json.bak"), ["Bash"]);
    await expect(refuseDeniedTools(base)).resolves.toBeUndefined();

    const security = path.join(dropIns, "20-security.json");
    settle(security, ["Bash(idlebiz *)"]);
    const refused = refuseDeniedTools(base);
    await expect(refused).rejects.toBeInstanceOf(RefusalError);
    await expect(refused).rejects.toThrow(`Bash(idlebiz *) (${security})`);

    rmSync(managed);
    await expect(refuseDeniedTools(base)).rejects.toThrow(security);
  });

  it("lets a run start past rules that leave the command alone, and settings it cannot read", async () => {
    settle(managed, ["Bash(rm:*)", "Bash(curl:*)", "WebFetch"]);
    await expect(refuseDeniedTools(base)).resolves.toBeUndefined();
    writeFileSync(managed, JSON.stringify({ permissions: { deny: "Bash" } }));
    await expect(refuseDeniedTools(base)).resolves.toBeUndefined();
    await expect(refuseDeniedTools(path.join(base, "none"))).resolves.toBeUndefined();
  });
});
