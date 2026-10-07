import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDoc } from "../store/frontmatter";

const SKILLS = path.resolve(import.meta.dirname, "../../../resources/skills/.agents/skills");

const shipped = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("IdleBiz's bundled skills", () => {
  it.each(shipped)("%s is one both runners load as written", (name) => {
    const { body, fields } = parseDoc(readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf-8"));
    expect(fields.name).toBe(name);
    // both runners skip a skill whose description is empty or longer
    expect(String(fields.description ?? "")).toMatch(/^.{1,1024}$/u);
    // a skill grants no tool and runs no command of its own: each goes through the run's asks
    expect(fields).not.toHaveProperty("allowed-tools");
    expect(body).not.toContain("!`");
  });
});
