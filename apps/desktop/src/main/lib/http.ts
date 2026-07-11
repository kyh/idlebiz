/** GET a JSON endpoint with a hard timeout; throws on any non-2xx status. */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000,
): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}
