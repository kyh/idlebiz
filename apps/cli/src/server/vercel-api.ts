import { z } from "zod";
import { jsonValueSchema } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { fetchOk } from "./lib/http";
import type { HttpError } from "./lib/http";

const VERCEL_API = "https://api.vercel.com";

/** The token a call is made with, and the team it acts in: null for the token's own account. */
export interface VercelScope {
  token: string;
  teamId: string | null;
}

type VercelQuery = Readonly<Record<string, string | undefined>>;

export interface VercelCallOptions {
  /** Required, since a deploy's calls share one deadline and every other call has its own. */
  signal: AbortSignal;
  init?: { method: "POST"; headers: Record<string, string>; body: string | Buffer } | undefined;
  /** A value left undefined is not sent. */
  query?: VercelQuery | undefined;
}

/** A call to Vercel's API in `scope`; throws HttpError on any non-2xx status. */
export const vercelCall = (
  route: string,
  { teamId, token }: VercelScope,
  { init, query = {}, signal }: VercelCallOptions,
): Promise<Response> => {
  const params = new URLSearchParams(
    Object.entries({ ...query, teamId: teamId ?? undefined }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return fetchOk(`${VERCEL_API}${route}${params.size > 0 ? `?${params.toString()}` : ""}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    signal,
  });
};

const READ_TIMEOUT_MS = 10_000;

export const vercelGetJson = async (
  route: string,
  scope: VercelScope,
  query?: VercelQuery,
): Promise<JsonValue> => {
  const res = await vercelCall(route, scope, {
    query,
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  return jsonValueSchema.parse(await res.json());
};

/** Vercel's word on what it turned down; `missing` is the files a deploy has yet to send. */
export const VercelSaid = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  missing: z.array(z.string()).optional(),
});
type Said = z.infer<typeof VercelSaid>;

const Refusal = z.object({ error: VercelSaid });

/** Vercel's word in a refused call's answer, or null when it sent none. */
export const vercelRefusalOf = (error: HttpError): Said | null => {
  const refusal = Refusal.safeParse(error.answer);
  return refusal.success ? refusal.data.error : null;
};

/** Vercel's words, with each `[sent, label]` it quotes of what was sent replaced by its label. */
export const vercelSays = (
  said: Said,
  ...redact: readonly (readonly [string, string])[]
): string => {
  let words = said.message ?? said.code ?? "no reason given";
  for (const [sent, label] of redact) {
    words = words.replaceAll(sent, label);
  }
  return words;
};
