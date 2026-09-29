import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEAM_NOTES_MAX_BYTES, readTeamNotes } from "@/main/agents/team-notes";
import { teamNotesPrompt } from "@/main/prompts/team-notes";

describe("readTeamNotes", () => {
  let box = "";
  let workspace = "";
  const notes = () => path.join(workspace, "AGENTS.md");

  beforeEach(() => {
    box = mkdtempSync(path.join(tmpdir(), "idlebiz-team-notes-"));
    workspace = path.join(box, "workspace");
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(box, { force: true, recursive: true });
  });

  it("reads the workspace's AGENTS.md", async () => {
    writeFileSync(notes(), "\n# Build\n\npnpm build\n\n");
    expect(await readTeamNotes(workspace)).toEqual({ cut: false, text: "# Build\n\npnpm build" });
  });

  it("finds none in a workspace without one, or with an empty one", async () => {
    expect(await readTeamNotes(workspace)).toBeNull();
    writeFileSync(notes(), " \n");
    expect(await readTeamNotes(workspace)).toBeNull();
  });

  it("cuts one longer than a run is handed, and says so", async () => {
    writeFileSync(notes(), "a".repeat(TEAM_NOTES_MAX_BYTES + 10));
    expect(await readTeamNotes(workspace)).toEqual({
      cut: true,
      text: "a".repeat(TEAM_NOTES_MAX_BYTES),
    });
    writeFileSync(notes(), "a".repeat(TEAM_NOTES_MAX_BYTES));
    expect(await readTeamNotes(workspace)).toMatchObject({ cut: false });
  });

  it("cuts before a character the limit would split, never inside it", async () => {
    writeFileSync(notes(), `${"a".repeat(TEAM_NOTES_MAX_BYTES - 1)}é`);
    expect(await readTeamNotes(workspace)).toEqual({
      cut: true,
      text: "a".repeat(TEAM_NOTES_MAX_BYTES - 1),
    });
  });

  it("reads AGENTS.override.md in AGENTS.md's place, as codex does", async () => {
    writeFileSync(notes(), "shared");
    writeFileSync(path.join(workspace, "AGENTS.override.md"), "override");
    expect(await readTeamNotes(workspace)).toEqual({ cut: false, text: "override" });
  });

  it("reads through a link to a file beside it, as a CLAUDE.md the notes once lived in", async () => {
    writeFileSync(path.join(workspace, "CLAUDE.md"), "pnpm build");
    symlinkSync("CLAUDE.md", notes());
    expect(await readTeamNotes(workspace)).toEqual({ cut: false, text: "pnpm build" });
  });

  it("never reads through a link a run left in its place to anything but a file beside it, nor a hard link", async () => {
    const sealed = path.join(box, "id_ed25519");
    writeFileSync(sealed, "PRIVATE KEY");
    symlinkSync(sealed, notes());
    expect(await readTeamNotes(workspace)).toBeNull();
    rmSync(notes());
    mkdirSync(path.join(workspace, "docs"));
    writeFileSync(path.join(workspace, "docs", "notes.md"), "pnpm build");
    symlinkSync("docs/notes.md", notes());
    expect(await readTeamNotes(workspace)).toBeNull();
    rmSync(notes());
    linkSync(sealed, notes());
    expect(await readTeamNotes(workspace)).toBeNull();
  });

  it("reads nothing from a folder or a FIFO in its place, and never waits on one", async () => {
    mkdirSync(notes());
    expect(await readTeamNotes(workspace)).toBeNull();
    rmSync(notes(), { recursive: true });
    execFileSync("/usr/bin/mkfifo", [notes()]);
    expect(await readTeamNotes(workspace)).toBeNull();
  });
});

describe("teamNotesPrompt", () => {
  it("frames the notes as the team's, and says when they were cut", () => {
    const whole = teamNotesPrompt({ cut: false, text: "pnpm build" });
    expect(whole).toContain("<team-notes>\npnpm build\n</team-notes>");
    expect(whole).toContain("not the founder");
    expect(whole).not.toContain("cut short");
    expect(teamNotesPrompt({ cut: true, text: "pnpm build" })).toContain("cut short");
  });
});
