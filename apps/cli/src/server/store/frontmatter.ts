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

const LINE = /^(?<key>[\w-]+)[ \t]*:(?:[ \t]+(?<value>.*?))?\s*$/su;
const COMMENT = /(?:^|[ \t])#/u;
const NOT_TEXT = /^(?:[|>&*!%@`,[\]{}]|[-?:](?:[ \t]|$))/u;
const ANOTHER_KEY = /:(?:[ \t]|$)/u;

const jsonString = (t: string) => {
  try {
    const parsed = z.string().safeParse(parseJson(t));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const readValue = (t: string) => {
  if (t === "" || t === "null" || t === "~") {
    return { value: null } satisfies { value: Scalar } | { refused: string };
  }

  if (t === "true") {
    return { value: true } satisfies { value: Scalar } | { refused: string };
  }

  if (t === "false") {
    return { value: false } satisfies { value: Scalar } | { refused: string };
  }

  if (t.startsWith('"')) {
    const text = jsonString(t);

    return (
      text === null
        ? {
            refused:
              'is not one JSON string: escape each " or \\ inside its quotes with a \\, and put nothing after the closing one',
          }
        : { value: text }
    ) satisfies { value: Scalar } | { refused: string };
  }

  if (COMMENT.test(t)) {
    return { refused: "has a comment after it: put the comment on a line of its own" } satisfies
      | { value: Scalar }
      | { refused: string };
  }

  if (t.startsWith("'")) {
    return {
      refused: "is in single quotes: write it in double quotes, as JSON, or in none",
    } satisfies { value: Scalar } | { refused: string };
  }

  if (NOT_TEXT.test(t)) {
    return {
      refused: `starts with ${JSON.stringify(t.charAt(0))}, which YAML does not read as text: write it on its one line in double quotes, as JSON`,
    } satisfies { value: Scalar } | { refused: string };
  }

  if (ANOTHER_KEY.test(t)) {
    return {
      refused:
        "holds a colon YAML reads as the start of another key: put it in double quotes, as JSON",
    } satisfies { value: Scalar } | { refused: string };
  }

  const n = Number(t);

  return { value: Number.isFinite(n) ? n : t } satisfies { value: Scalar } | { refused: string };
};

const jsonValue = (v: Scalar) =>
  JSON.stringify(v)
    .replaceAll("\u2028", String.raw`\u2028`)
    .replaceAll("\u2029", String.raw`\u2029`);

const blockLines = (block: WrittenDoc["fields"], indent: string) =>
  Object.entries(block).flatMap(([k, v]) =>
    v === undefined ? [] : [`${indent}${k}: ${jsonValue(v)}`],
  );

export const serializeDoc = (doc: WrittenDoc) => {
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

interface Head {
  fields: Record<string, Scalar>;
  metadata: Record<string, Scalar>;
  metaIndent: string | null;
}

const readLine = (head: Head, line: string, at: string) => {
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

export const parseDoc = (text: string) => {
  if (!text.startsWith("---\n")) {
    return { body: text, fields: {}, metadata: {} } satisfies FrontmatterDoc;
  }

  const end = text.indexOf("\n---", 4);

  if (end === -1) {
    return { body: text, fields: {}, metadata: {} } satisfies FrontmatterDoc;
  }

  let body = text.slice(end + 4);

  if (body.startsWith("\n")) {
    body = body.slice(1);
  }

  const head: Head = { fields: {}, metaIndent: null, metadata: {} };
  let refusal: string | null = null;

  for (const [index, line] of text.slice(4, end).split("\n").entries()) {
    if (line.trim() !== "" && !line.trimStart().startsWith("#")) {
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

  return { body, fields, metadata } satisfies FrontmatterDoc;
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
export const decodeDoc = <T>(schema: z.ZodType<T>, doc: FrontmatterDoc) => {
  const parsed = schema.safeParse(doc);

  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }

  return parsed.data;
};

/** URL-safe slug from a human name; suffix for uniqueness is the caller's job. */
export const slugify = (name: string) => {
  const s = name
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48);

  return s || "item";
};
