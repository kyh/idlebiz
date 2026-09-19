// Constrained YAML: top-level scalars plus one indented metadata block.
// Strings use JSON quoting; free text lives in the markdown body.

import { z } from "zod";
import { parseJson } from "@/shared/json";

export type Scalar = string | number | boolean | null;
export interface FrontmatterDoc {
  fields: Record<string, Scalar>;
  metadata: Record<string, Scalar>;
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

export const serializeDoc = (doc: FrontmatterDoc): string => {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(doc.fields)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  const meta = Object.entries(doc.metadata);
  if (meta.length > 0) {
    lines.push("metadata:");
    for (const [k, v] of meta) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---", "");
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
  return { body, fields, metadata };
};

export const reqStr = (rec: Record<string, Scalar>, key: string): string => {
  const v = z.string().safeParse(rec[key]);
  if (!v.success) {
    throw new Error(`expected string "${key}"`);
  }
  return v.data;
};
export const optStr = (rec: Record<string, Scalar>, key: string): string | null => {
  const v = z.string().safeParse(rec[key]);
  return v.success ? v.data : null;
};
export const reqNum = (rec: Record<string, Scalar>, key: string): number => {
  const v = z.number().safeParse(rec[key]);
  if (!v.success) {
    throw new Error(`expected number "${key}"`);
  }
  return v.data;
};
export const optNum = (rec: Record<string, Scalar>, key: string, fallback: number): number => {
  const v = z.number().safeParse(rec[key]);
  return v.success ? v.data : fallback;
};
export const nullableNum = (rec: Record<string, Scalar>, key: string): number | null => {
  const v = z.number().safeParse(rec[key]);
  return v.success ? v.data : null;
};
export const optBool = (rec: Record<string, Scalar>, key: string, fallback: boolean): boolean => {
  const v = z.boolean().safeParse(rec[key]);
  return v.success ? v.data : fallback;
};
/** A JSON array of strings stored as one scalar; anything else reads as empty. */
export const strArray = (rec: Record<string, Scalar>, key: string): string[] => {
  const v = z.string().safeParse(rec[key]);
  if (!v.success) {
    return [];
  }
  try {
    const parsed = z.array(z.string()).safeParse(parseJson(v.data));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
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
