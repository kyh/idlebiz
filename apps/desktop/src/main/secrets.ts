import path from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile, readJsonFileForUpdate } from "@/main/lib/fs";
import { ROOT_DIR } from "@/main/paths";
import { jsonRecordSchema } from "@/shared/json";
import type { JsonRecord } from "@/shared/json";

// Founder secrets use mode 0600 and reach agents through their inherited environment.

const SECRETS_PATH = path.join(ROOT_DIR, "secrets.json");

/**
 * Kept out of the env every run inherits: the grant is read-only, so it cannot charge, and
 * it belongs to the one company that connected it (`stripeCredential`), while the env
 * outlives that company. Metrics reads it from the file.
 */
export const STRIPE_CONNECT_TOKEN = "STRIPE_CONNECT_TOKEN";

const inEnv = (key: string): boolean => !key.startsWith("_") && key !== STRIPE_CONNECT_TOKEN;

const readSecretsForUpdate = (): JsonRecord | null =>
  readJsonFileForUpdate(SECRETS_PATH, jsonRecordSchema);

const writeSecretsFile = (raw: JsonRecord): void =>
  atomicWrite(SECRETS_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 });

const stringsOf = (raw: JsonRecord): Record<string, string> =>
  Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, string] => z.string().safeParse(entry[1]).success,
    ),
  );

/** Export the string secrets into this process's env; returns what boot reports when secrets.json can't be read. */
export const exportSecretsToEnv = (): { file: string; cause: unknown } | null => {
  let raw: JsonRecord | null;
  try {
    raw = readSecretsForUpdate();
  } catch (error) {
    return { cause: error, file: SECRETS_PATH };
  }
  if (raw === null) {
    // seed an empty, documented file so the founder knows where keys go
    try {
      writeSecretsFile({
        _readme:
          "Founder secrets. String values are exported as env vars to your employees and the metrics providers. e.g. STRIPE_SECRET_KEY, VERCEL_TOKEN.",
      });
    } catch {
      /* best effort */
    }
    return null;
  }
  for (const [k, v] of Object.entries(stringsOf(raw))) {
    if (inEnv(k)) {
      process.env[k] = v;
    }
  }
  return null;
};

export const getSecret = (key: string): string | null =>
  stringsOf(readJsonFile(SECRETS_PATH, jsonRecordSchema) ?? {})[key] ?? null;

export const setSecret = (key: string, value: string): void => {
  const raw = readSecretsForUpdate() ?? {};
  raw[key] = value;
  writeSecretsFile(raw);
  if (inEnv(key)) {
    process.env[key] = value;
  }
};

export const deleteSecret = (key: string): void => {
  const raw = readSecretsForUpdate();
  if (raw === null) {
    return;
  }
  writeSecretsFile(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== key)));
  // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
  delete process.env[key];
};
