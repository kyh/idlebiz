// Minimal agentcompanies/v1 frontmatter codec — no YAML dep, strict types.
//
// We only ever WRITE a constrained YAML subset, so parsing stays trivial:
//   - top-level scalar fields, one `metadata:` block of indented scalars
//   - every string/array value is serialized as JSON (JSON is a YAML subset),
//     numbers/booleans/null are bare — so reading is JSON.parse per value.
// Free text (mission, persona, task description) lives in the markdown BODY,
// never in frontmatter, which is what keeps this codec safe.

import { z } from "zod";
import type { JsonValue } from "@/shared/json";

export type Scalar = string | number | boolean | null;
export interface FrontmatterDoc {
  fields: Record<string, Scalar>;
  metadata: Record<string, Scalar>;
  body: string;
}

// JSON.stringify quotes strings and renders numbers/booleans/null bare —
// exactly this codec's serialization for every Scalar.
function writeValue(v: Scalar): string {
  return JSON.stringify(v);
}

function parseValue(raw: string): Scalar {
  const t = raw.trim();
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t)) && !t.startsWith('"')) return Number(t);
  if (t.startsWith('"')) {
    try {
      const parsed = z.string().safeParse(JSON.parse(t));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to raw */
    }
  }
  return t; // bare string (we never write these, but tolerate them)
}

export function serializeDoc(doc: FrontmatterDoc): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(doc.fields)) lines.push(`${k}: ${writeValue(v)}`);
  const meta = Object.entries(doc.metadata);
  if (meta.length > 0) {
    lines.push("metadata:");
    for (const [k, v] of meta) lines.push(`  ${k}: ${writeValue(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n") + doc.body;
}

export function parseDoc(text: string): FrontmatterDoc {
  const fields: Record<string, Scalar> = {};
  const metadata: Record<string, Scalar> = {};
  if (!text.startsWith("---\n")) return { fields, metadata, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { fields, metadata, body: text };
  const head = text.slice(4, end);
  let body = text.slice(end + 4);
  if (body.startsWith("\n")) body = body.slice(1);

  let inMeta = false;
  for (const line of head.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indented = line.startsWith("  ");
    if (!indented && line.replace(/\s+$/, "") === "metadata:") {
      inMeta = true;
      continue;
    }
    const target = indented && inMeta ? metadata : fields;
    if (!indented) inMeta = false;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key) target[key] = parseValue(value);
  }
  return { fields, metadata, body };
}

// ---- typed readers (parse-boundary narrowing; throw = corrupt file) --------
export function reqStr(rec: Record<string, Scalar>, key: string): string {
  const v = z.string().safeParse(rec[key]);
  if (!v.success) throw new Error(`expected string "${key}"`);
  return v.data;
}
export function optStr(rec: Record<string, Scalar>, key: string): string | null {
  const v = z.string().safeParse(rec[key]);
  return v.success ? v.data : null;
}
export function reqNum(rec: Record<string, Scalar>, key: string): number {
  const v = z.number().safeParse(rec[key]);
  if (!v.success) throw new Error(`expected number "${key}"`);
  return v.data;
}
export function optNum(rec: Record<string, Scalar>, key: string, fallback: number): number {
  const v = z.number().safeParse(rec[key]);
  return v.success ? v.data : fallback;
}
export function optBool(rec: Record<string, Scalar>, key: string, fallback: boolean): boolean {
  const v = z.boolean().safeParse(rec[key]);
  return v.success ? v.data : fallback;
}
export function strArray(rec: Record<string, Scalar>, key: string): string[] {
  const v = z.string().safeParse(rec[key]);
  if (!v.success) return [];
  try {
    // JSON.parse is typed `any`; its actual return domain is exactly JsonValue.
    const parsed: JsonValue = JSON.parse(v.data);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => z.string().safeParse(x).success)
      : [];
  } catch {
    return [];
  }
}

/** URL-safe slug from a human name; suffix for uniqueness is the caller's job. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "item";
}
