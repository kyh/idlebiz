import { describe, expect, it } from "vitest";
import { parseDoc, serializeDoc } from "./frontmatter";

/** A package file whose frontmatter is `head`, one line each, as a founder's editor saves it. */
const file = (...head: string[]): string => ["---", ...head, "---", "Body."].join("\n");

describe("frontmatter as the app writes it", () => {
  it.each([
    "Acme",
    "",
    "'single quotes'",
    "a # that is no comment",
    "| no block",
    "key: no key",
    'a "quote" and a \\ backslash',
    "two\nlines",
    "a line\u2028separator",
    "a paragraph\u2029separator",
    "ünïcödé ✓",
    "42",
    "true",
    "null",
    0,
    -1.5,
    1e21,
    Number.MAX_SAFE_INTEGER,
    true,
    false,
    null,
  ])("reads back %j as it was written", (value) => {
    const doc = { body: "Body.\n", fields: { name: value }, metadata: { note: value } };

    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });

  it("writes a line or paragraph separator escaped, and reads one an older write left raw", () => {
    const value = "a\u2028b\u2029c";

    expect(serializeDoc({ body: "", fields: { name: value }, metadata: {} })).toContain(
      String.raw`name: "a\u2028b\u2029c"`,
    );
    expect(parseDoc(file(`name: ${JSON.stringify(value)}`)).fields).toEqual({ name: value });
  });
});

describe("frontmatter a founder edits", () => {
  it("reads what YAML reads, as YAML reads it", () => {
    expect(
      parseDoc(
        file(
          "# the founder's own note",
          "name: Acme Rockets",
          "website: https://acme.example/launch?ref=1",
          "",
          "seats: 12",
          "autopilot: false",
          "leaderId: ~",
          "description:",
          "metadata:",
          "    format: 16",
          "    # a note under metadata",
          "    founderName: Kai",
        ),
      ),
    ).toEqual({
      body: "Body.",
      fields: {
        autopilot: false,
        description: null,
        leaderId: null,
        name: "Acme Rockets",
        seats: 12,
        website: "https://acme.example/launch?ref=1",
      },
      metadata: { format: 16, founderName: "Kai" },
    });
  });

  it.each([
    [["name: 'Acme'"], "line 2: name is in single quotes"],
    [["name: Acme", 'slug: "acme" # hand note'], "line 3: slug is not one JSON string"],
    [["name: Acme # hand note"], "line 2: name has a comment after it"],
    [["description: |", "  Ships to-dos."], 'line 2: description starts with "|"'],
    [["description: Ships to-dos", "  and plans them."], "line 3 is indented"],
    [['name: "Acme'], "line 2: name is not one JSON string"],
    [["name: Acme", "a note with no key"], 'line 3 is not "key: value"'],
    [["tags:", "- launch"], 'line 3 is not "key: value"'],
    [["name: Acme", "name: Acme Rockets"], "line 3: name is set twice"],
    [["name: Acme: the rocket company"], "line 2: name holds a colon"],
    [["metadata:", "  format: 16", "    createdAt: 1"], "line 4 is indented"],
    [["metadata:", "\tformat: 16"], 'line 3 is not "key: value"'],
  ])("refuses %j, naming its line", (head, refusal) => {
    expect(() => parseDoc(file(...head))).toThrow(refusal);
  });

  it("names a file of another schema as that, before a line it cannot read", () => {
    expect(() =>
      parseDoc(file("description: >", "  Someone else's.", 'schema: "agentcompanies/v9"')),
    ).toThrow('written as "agentcompanies/v9"');
  });
});
