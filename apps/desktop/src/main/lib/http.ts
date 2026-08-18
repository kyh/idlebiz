import type { JsonValue } from "@/shared/json";

/** GET a JSON endpoint with a hard timeout; throws on any non-2xx status. */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000,
): Promise<JsonValue> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  // Response.json() is typed `any`; its actual return domain is exactly JsonValue.
  const data: JsonValue = await res.json();
  return data;
}
