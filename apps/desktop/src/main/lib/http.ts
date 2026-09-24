import type { Server } from "node:http";
import { z } from "zod";
import { jsonValueSchema, parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";

/** A non-2xx answer, with the status so a caller can tell "revoked" from "down". */
export class HttpError extends Error {
  readonly status: number;
  /** The body it came with, when that was JSON: most APIs say why there. */
  readonly answer: JsonValue | null;

  constructor(status: number, url: string, answer: JsonValue | null = null) {
    super(`${url} -> ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.answer = answer;
  }

  /** 401/403: the credential was turned away, as opposed to the service being down. */
  get refused(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const failure = async (res: Response, url: string): Promise<HttpError> => {
  try {
    return new HttpError(res.status, url, parseJson(await res.text()));
  } catch {
    return new HttpError(res.status, url);
  }
};

/** GET a JSON endpoint with a hard timeout; throws HttpError on any non-2xx status. */
export const getJson = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000,
): Promise<JsonValue> => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw await failure(res, url);
  }
  return jsonValueSchema.parse(await res.json());
};

/** POST a form to a JSON endpoint with a hard timeout; throws HttpError on any non-2xx status. */
export const postForm = async (
  url: string,
  headers: Record<string, string>,
  form: Readonly<Record<string, string>>,
  timeoutMs = 8000,
): Promise<JsonValue> => {
  const res = await fetch(url, {
    body: new URLSearchParams(form),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw await failure(res, url);
  }
  return jsonValueSchema.parse(await res.json());
};

/** Bind a server to an ephemeral loopback port and return the port. */
export const listenLoopback = async (server: Server): Promise<number> => {
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
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
};
