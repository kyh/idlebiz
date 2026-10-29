// Constrained YAML: top-level scalars plus one indented metadata block.
// Strings use JSON quoting; free text lives in the markdown body. A hand edit beyond that is
// refused, its line named, never read as near as it comes: YAML reads `'Acme'` without its
// quotes and `"acme" # note` without its comment, and a load that kept either would hold a
// value nobody wrote.

import { z } from "zod";
import { parseJson } from "@repo/domain/json";

/** The package format every file here is written in. A file naming another is someone else's, and is left alone. */
export const PACKAGE_SCHEMA = "agentcompanies/v1";

type Scalar = string | number | boolean | null;
export interface FrontmatterDoc {
  fields: Record<string, Scalar>;
  metadata: Record<string, Scalar>;
  body: string;
}

/** A doc as an encoder writes it: a key left undefined gets no line, so it reads back absent. */
interface WrittenDoc {
  fields: Record<string, Scalar | undefined>;
  metadata: Record<string, Scalar | undefined>;
  body: string;
}

/**
 * A line of the head, past its indent: a key, its colon, then its value after a space, if any. A
 * line or paragraph separator is no line break here, as in JSON, so the value runs on past one.
 */
const LINE = /^(?<key>[\w-]+)[ \t]*:(?:[ \t]+(?<value>.*?))?\s*$/su;
/** A comment, which YAML reads as no part of the value. */
const COMMENT = /(?:^|[ \t])#/u;
/** A first character YAML reads as more than text: a block, anchor, alias, tag, flow or reserved sign. */
const NOT_TEXT = /^(?:[|>&*!%@`,[\]{}]|[-?:](?:[ \t]|$))/u;
/** A colon YAML reads as the start of another key's value. */
const ANOTHER_KEY = /:(?:[ \t]|$)/u;

/** `t` as one whole JSON string; null when it is not one. */
const jsonString = (t: string): string | null => {
  try {
    const parsed = z.string().safeParse(parseJson(t));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * A value as YAML reads it: null, a boolean, a number, one JSON string, or text YAML reads as
 * written. Anything else is refused, saying what to write instead.
 */
const readValue = (t: string): { value: Scalar } | { refused: string } => {
  if (t === "" || t === "null" || t === "~") {
    return { value: null };
  }
  if (t === "true") {
    return { value: true };
  }
  if (t === "false") {
    return { value: false };
  }
  if (t.startsWith('"')) {
    const text = jsonString(t);
    return text === null
      ? {
          refused:
            'is not one JSON string: escape each " or \\ inside its quotes with a \\, and put nothing after the closing one',
        }
      : { value: text };
  }
  if (COMMENT.test(t)) {
    return { refused: "has a comment after it: put the comment on a line of its own" };
  }
  if (t.startsWith("'")) {
    return { refused: "is in single quotes: write it in double quotes, as JSON, or in none" };
  }
  if (NOT_TEXT.test(t)) {
    return {
      refused: `starts with ${JSON.stringify(t.charAt(0))}, which YAML does not read as text: write it on its one line in double quotes, as JSON`,
    };
  }
  if (ANOTHER_KEY.test(t)) {
    return {
      refused:
        "holds a colon YAML reads as the start of another key: put it in double quotes, as JSON",
    };
  }
  return { value: Number.isNaN(Number(t)) ? t : Number(t) };
};

/** A value as JSON, a line or paragraph separator escaped too: JSON leaves both raw, and an editor breaks the line there. */
const jsonValue = (v: Scalar): string =>
  JSON.stringify(v)
    .replaceAll("\u2028", String.raw`\u2028`)
    .replaceAll("\u2029", String.raw`\u2029`);

/** A block's lines, each indented by `indent`: a key left undefined gets none. */
const blockLines = (block: WrittenDoc["fields"], indent: string): string[] =>
  Object.entries(block).flatMap(([k, v]) =>
    v === undefined ? [] : [`${indent}${k}: ${jsonValue(v)}`],
  );

export const serializeDoc = (doc: WrittenDoc): string => {
  const meta = blockLines(doc.metadata, "  ");
  const lines = [
    "---",
    ...blockLines(doc.fields, ""),
    ...(meta.length > 0 ? ["metadata:", ...meta] : []),
    "---",
    "",
  ];
  return lines.join("\n") + doc.body;
};

/** The head as read so far. */
interface Head {
  fields: Record<string, Scalar>;
  metadata: Record<string, Scalar>;
  /** Null outside metadata; inside, the indent its first line set, "" until one has. */
  metaIndent: string | null;
}

/** Read one line of the head, `at` naming it, into `head`: what it refuses, or null. */
const readLine = (head: Head, line: string, at: string): string | null => {
  const indent = line.slice(0, line.search(/[^ ]/u));
  if (indent === "") {
    head.metaIndent = null;
  } else if (head.metaIndent === "" || head.metaIndent === indent) {
    head.metaIndent = indent;
  } else {
    return `${at} is indented, but only the lines under metadata: are, each alike: a value goes on its key's line, and free text in the body`;
  }
  const groups = LINE.exec(line.slice(indent.length))?.groups;
  if (groups === undefined) {
    return `${at} is not "key: value": free text goes in the body, below the closing ---`;
  }
  const { key = "", value = "" } = groups;
  if (indent === "" && key === "metadata" && value === "") {
    head.metaIndent = "";
    return null;
  }
  const block = indent === "" ? head.fields : head.metadata;
  const read = Object.hasOwn(block, key) ? { refused: "is set twice: keep one" } : readValue(value);
  if ("refused" in read) {
    return `${at}: ${key} ${read.refused}`;
  }
  block[key] = read.value;
  return null;
};

export const parseDoc = (text: string): FrontmatterDoc => {
  if (!text.startsWith("---\n")) {
    return { body: text, fields: {}, metadata: {} };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    return { body: text, fields: {}, metadata: {} };
  }
  let body = text.slice(end + 4);
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }

  const head: Head = { fields: {}, metaIndent: null, metadata: {} };
  // the first line it cannot read, refused once the file is known to be this app's
  let refusal: string | null = null;
  for (const [index, line] of text.slice(4, end).split("\n").entries()) {
    if (line.trim() !== "" && !line.trimStart().startsWith("#")) {
      // the opening --- is the file's line 1
      const refused = readLine(head, line, `line ${index + 2}`);
      refusal ??= refused;
    }
  }
  const { fields, metadata } = head;
  const { schema } = fields;
  if (schema !== undefined && schema !== PACKAGE_SCHEMA) {
    throw new Error(`written as "${String(schema)}", which this app does not read`);
  }
  if (refusal !== null) {
    throw new Error(refusal);
  }
  return { body, fields, metadata };
};

/** The top-level fields of every package kind but a routine, whose files name no kind. */
export const packageFields = <K extends string>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    name: z.string(),
    schema: z.literal(PACKAGE_SCHEMA),
    slug: z.string(),
  });

/** `doc` as `schema` reads it. One it refuses throws what is wrong, which the load report names. */
export const decodeDoc = <T>(schema: z.ZodType<T>, doc: FrontmatterDoc): T => {
  const parsed = schema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
};

/** URL-safe slug from a human name; suffix for uniqueness is the caller's job. */
export const slugify = (name: string): string => {
  const s = name
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48);
  return s || "item";
};
