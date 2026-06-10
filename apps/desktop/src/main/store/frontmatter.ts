// Minimal agentcompanies/v1 frontmatter codec — zero deps, strict types.
//
// We only ever WRITE a constrained YAML subset, so parsing stays trivial:
//   - top-level scalar fields, one `metadata:` block of indented scalars
//   - every string/array value is serialized as JSON (JSON is a YAML subset),
//     numbers/booleans/null are bare — so reading is JSON.parse per value.
// Free text (mission, persona, task description) lives in the markdown BODY,
// never in frontmatter, which is what keeps this codec safe.

export type Scalar = string | number | boolean | null;
export interface FrontmatterDoc {
  fields: Record<string, Scalar>;
  metadata: Record<string, Scalar>;
  body: string;
}

function writeValue(v: Scalar): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  return String(v);
}

function parseValue(raw: string): Scalar {
  const t = raw.trim();
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t)) && !t.startsWith('"')) return Number(t);
  if (t.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === "string") return parsed;
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
  const v = rec[key];
  if (typeof v !== "string") throw new Error(`expected string "${key}"`);
  return v;
}
export function optStr(rec: Record<string, Scalar>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" ? v : null;
}
export function reqNum(rec: Record<string, Scalar>, key: string): number {
  const v = rec[key];
  if (typeof v !== "number") throw new Error(`expected number "${key}"`);
  return v;
}
export function optNum(rec: Record<string, Scalar>, key: string, fallback: number): number {
  const v = rec[key];
  return typeof v === "number" ? v : fallback;
}
export function optBool(rec: Record<string, Scalar>, key: string, fallback: boolean): boolean {
  const v = rec[key];
  return typeof v === "boolean" ? v : fallback;
}
export function strArray(rec: Record<string, Scalar>, key: string): string[] {
  const v = rec[key];
  if (typeof v !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
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
