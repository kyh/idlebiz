import type { Server } from "node:http";
import { z } from "zod";
import type { JsonValue } from "@/shared/json";

/** A non-2xx answer, with the status so a caller can tell "revoked" from "down". */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${url} -> ${status}`);
  }
}

/** GET a JSON endpoint with a hard timeout; throws HttpError on any non-2xx status. */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000,
): Promise<JsonValue> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new HttpError(res.status, url);
  // Response.json() is typed `any`; its actual return domain is exactly JsonValue.
  const data: JsonValue = await res.json();
  return data;
}

/** Bind a server to an ephemeral loopback port and return the port. */
export async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // address() is AddressInfo | string | null; only the object form has a port
  const address = z.object({ port: z.number() }).safeParse(server.address());
  if (!address.success) {
    server.close();
    throw new Error("loopback server failed to bind");
  }
  return address.data.port;
}
