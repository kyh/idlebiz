import { z } from "zod";
import { HttpError, fetchOk } from "@/main/lib/http";
import { ENV_PREFIX, hasSecret, secretsUnder, setSecret } from "@/main/secrets";
import { VERCEL_API } from "@/main/vercel";
import type { Product, VercelBinding } from "@/shared/domain";
import { isPublicEnvName } from "@/shared/env-name";
import { errorMessage } from "@/shared/errors";

/** One variable for a product's bound project, set with the founder's token. */
export interface EnvRequest {
  token: string;
  binding: VercelBinding;
  name: string;
  value: string;
  /**
   * The team set this name before, so its value is replaced. Any other name is only ever
   * created: the founder may have bound a live project whose variables are theirs.
   */
  replaces: boolean;
}

/** `error` is why Vercel holds no new value, in its words when it gave any, never the value's. */
export type EnvResult = { ok: true } | { ok: false; error: string };

export type EnvSetter = (req: EnvRequest) => Promise<EnvResult>;

/** A value a teammate set on a product's project under a server-only name, which no deploy may ship. */
export interface KeptEnvValue {
  kind: "env";
  company: string;
  product: string;
  name: string;
  value: string;
}

type ProductRef = Pick<Product, "companyId" | "id">;

const keptKey = ({ companyId, id }: ProductRef, name: string): string =>
  `${ENV_PREFIX}${companyId}/${id}/${name}`;

/** Whether set_env set `name` on the product before, even a value this launch cannot open. */
export const teamSetEnv = (product: ProductRef, name: string): boolean =>
  hasSecret(keptKey(product, name));

/** Keep a value Vercel now holds, both as the team's name to replace and for the deploy guard. */
export const keepEnvValue = (product: ProductRef, name: string, value: string): void => {
  setSecret(keptKey(product, name), value);
};

/**
 * Every value set_env set under a server-only name, in any company (secrets.json is every
 * company's, and never the save, which runs read): one product's key ships as publicly from
 * another's folder. A value under a public name is built into the page anyway, so a file
 * holding it ships nothing new.
 */
export const unshippableEnvValues = (): KeptEnvValue[] =>
  [...secretsUnder(ENV_PREFIX)].flatMap(([key, value]) => {
    const [company, product, name, ...rest] = key.split("/");
    return company === undefined ||
      product === undefined ||
      name === undefined ||
      rest.length > 0 ||
      isPublicEnvName(name)
      ? []
      : [{ company, kind: "env", name, product, value }];
  });

const ENV_TIMEOUT_MS = 10_000;

const Said = z.object({ code: z.string().optional(), message: z.string().optional() });
const Refusal = z.object({ error: Said });
const Answer = z.object({ failed: z.array(z.object({ error: Said })).default([]) });

/** Vercel's words, less anything they quote of what was sent. */
const reasonOf = (said: z.infer<typeof Said>, { token, value }: EnvRequest): string =>
  (said.message ?? said.code ?? "no reason given")
    .replaceAll(value, "[the value]")
    .replaceAll(token, "[the token]");

/**
 * Set a variable on the product's project through Vercel's API, here in main so an
 * employee's process never holds the token: sensitive, so nobody reads it back from the
 * dashboard, for production and preview. A 201 can still carry a failure, so `failed` is
 * read too. Nothing is retried as another type: a variable made readable is one the team
 * never asked for.
 */
export const setVercelEnv: EnvSetter = async (req) => {
  const { binding, name, replaces, token, value } = req;
  const query = new URLSearchParams(replaces ? { upsert: "true" } : {});
  if (binding.teamId !== null) {
    query.set("teamId", binding.teamId);
  }
  try {
    const res = await fetchOk(
      `${VERCEL_API}/v10/projects/${encodeURIComponent(binding.projectId)}/env?${query.toString()}`,
      {
        body: JSON.stringify({
          key: name,
          target: ["production", "preview"],
          type: "sensitive",
          value,
        }),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(ENV_TIMEOUT_MS),
      },
    );
    const [failed] = Answer.parse(await res.json()).failed;
    return failed === undefined
      ? { ok: true }
      : { error: `Vercel turned it down: ${reasonOf(failed.error, req)}`, ok: false };
  } catch (error) {
    if (!(error instanceof HttpError)) {
      return { error: errorMessage(error), ok: false };
    }
    const said = Refusal.safeParse(error.answer);
    const why = said.success ? `: ${reasonOf(said.data.error, req)}` : "";
    return { error: `Vercel turned it down (${error.status})${why}`, ok: false };
  }
};
