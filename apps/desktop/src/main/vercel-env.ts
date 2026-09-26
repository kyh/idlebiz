import { z } from "zod";
import { HttpError, fetchOk } from "@/main/lib/http";
import { secretsUnder, setSecret } from "@/main/secrets";
import { VERCEL_API } from "@/main/vercel";
import type { VercelBinding } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";

/** One variable for a product's bound project, set with the founder's token. */
export interface EnvRequest {
  token: string;
  binding: VercelBinding;
  name: string;
  value: string;
}

/** `error` is why Vercel holds no new value, in its words when it gave any, never the value's. */
export type EnvResult = { ok: true } | { ok: false; error: string };

export type EnvSetter = (req: EnvRequest) => Promise<EnvResult>;

/** A value a teammate set on a product's project, which no deploy may ship. */
export interface KeptEnvValue {
  product: string;
  name: string;
  value: string;
}

// secrets.json, not the save: every run can read the save
const KEPT = "ENV/";

/** Keep `value` for the deploy guard before Vercel is asked: it was handed over as a secret either way. */
export const keepEnvValue = (product: string, name: string, value: string): void => {
  setSecret(`${KEPT}${product}/${name}`, value);
};

/** Every value set_env was given, on any product: one product's key ships as publicly from another's folder. */
export const keptEnvValues = (): KeptEnvValue[] =>
  [...secretsUnder(KEPT)].flatMap(([key, value]) => {
    const slash = key.indexOf("/");
    return slash === -1
      ? []
      : [{ name: key.slice(slash + 1), product: key.slice(0, slash), value }];
  });

const Said = z.object({ code: z.string().optional(), message: z.string().optional() });
const Refusal = z.object({ error: Said });
const Answer = z.object({ failed: z.array(z.object({ error: Said })).default([]) });

const reasonOf = (said: z.infer<typeof Said>): string =>
  said.message ?? said.code ?? "no reason given";

type Attempt = { kind: "set" } | { kind: "turned-down"; retry: boolean; reason: string };

/**
 * Upsert the variable for production and preview. A 201 can still carry a failure, so
 * `failed` is read too. Vercel keeps a variable's type once made and documents no word
 * for an upsert that would change it, so a 400, a 409 or a failure in the answer may
 * mean only that, and is worth one more try as the type the variable already has.
 */
const upsert = async (
  { binding, name, token, value }: EnvRequest,
  type: "sensitive" | "encrypted",
): Promise<Attempt> => {
  const query = new URLSearchParams({ upsert: "true" });
  if (binding.teamId !== null) {
    query.set("teamId", binding.teamId);
  }
  try {
    const res = await fetchOk(
      `${VERCEL_API}/v10/projects/${encodeURIComponent(binding.projectId)}/env?${query.toString()}`,
      {
        body: JSON.stringify({ key: name, target: ["production", "preview"], type, value }),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const [failed] = Answer.parse(await res.json()).failed;
    return failed === undefined
      ? { kind: "set" }
      : {
          kind: "turned-down",
          reason: `Vercel turned it down: ${reasonOf(failed.error)}`,
          retry: true,
        };
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    const said = Refusal.safeParse(error.answer);
    const why = said.success ? `: ${reasonOf(said.data.error)}` : "";
    return {
      kind: "turned-down",
      reason: `Vercel turned it down (${error.status})${why}`,
      retry: error.status === 400 || error.status === 409,
    };
  }
};

/**
 * Set a variable on the product's project through Vercel's API, here in main so an
 * employee's process never holds the token. Sensitive, so nobody reads it back from the
 * dashboard; encrypted where the variable already exists as a readable one.
 */
export const setVercelEnv: EnvSetter = async (req) => {
  try {
    let attempt = await upsert(req, "sensitive");
    if (attempt.kind === "turned-down" && attempt.retry) {
      attempt = await upsert(req, "encrypted");
    }
    return attempt.kind === "set" ? { ok: true } : { error: attempt.reason, ok: false };
  } catch (error) {
    return { error: errorMessage(error), ok: false };
  }
};
