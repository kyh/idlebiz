// Constrained YAML: top-level scalars plus one indented metadata block.
// Strings use JSON quoting; free text lives in the markdown body.

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

const parseValue = (raw: string): Scalar => {
  const t = raw.trim();
  if (t === "null" || t === "~") {
    return null;
  }
  if (t === "true") {
    return true;
  }
  if (t === "false") {
    return false;
  }
  if (t !== "" && !Number.isNaN(Number(t)) && !t.startsWith('"')) {
    return Number(t);
  }
  if (t.startsWith('"')) {
    try {
      const parsed = z.string().safeParse(parseJson(t));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      /* fall through to raw */
    }
  }
  // bare string (we never write these, but tolerate them)
  return t;
};

/** A block's lines, each indented by `indent`: a key left undefined gets none. */
const blockLines = (block: WrittenDoc["fields"], indent: string): string[] =>
  Object.entries(block).flatMap(([k, v]) =>
    v === undefined ? [] : [`${indent}${k}: ${JSON.stringify(v)}`],
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

export const parseDoc = (text: string): FrontmatterDoc => {
  const fields: Record<string, Scalar> = {};
  const metadata: Record<string, Scalar> = {};
  if (!text.startsWith("---\n")) {
    return { body: text, fields, metadata };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    return { body: text, fields, metadata };
  }
  const head = text.slice(4, end);
  let body = text.slice(end + 4);
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }

  let inMeta = false;
  for (const line of head.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const indented = line.startsWith("  ");
    if (!indented && line.replace(/\s+$/u, "") === "metadata:") {
      inMeta = true;
      continue;
    }
    const target = indented && inMeta ? metadata : fields;
    if (!indented) {
      inMeta = false;
    }
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key) {
      target[key] = parseValue(value);
    }
  }
  const { schema } = fields;
  if (schema !== undefined && schema !== PACKAGE_SCHEMA) {
    throw new Error(`written as "${String(schema)}", which this app does not read`);
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
