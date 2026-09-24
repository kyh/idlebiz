import path from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile, readJsonFileForUpdate } from "@/main/lib/fs";
import { ROOT_DIR } from "@/main/paths";
import { jsonRecordSchema } from "@/shared/json";
import type { JsonRecord } from "@/shared/json";

// Founder secrets use mode 0600 and stay in main: IdleBiz reads each where it uses it, and
// no employee's environment ever carries one.

const SECRETS_PATH = path.join(ROOT_DIR, "secrets.json");

export const STRIPE_CONNECT_TOKEN = "STRIPE_CONNECT_TOKEN";

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

/**
 * Seeds a documented file where there is none, so the founder knows where keys go; returns
 * what boot reports when secrets.json can't be read.
 */
export const checkSecrets = (): { file: string; cause: unknown } | null => {
  let raw: JsonRecord | null;
  try {
    raw = readSecretsForUpdate();
  } catch (error) {
    return { cause: error, file: SECRETS_PATH };
  }
  if (raw === null) {
    try {
      writeSecretsFile({
        _readme:
          "Founder secrets, e.g. STRIPE_SECRET_KEY, VERCEL_TOKEN. IdleBiz uses them itself for its reads, deploys and payment links; they are never given to your employees.",
      });
    } catch {
      /* best effort */
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
};

export const deleteSecret = (key: string): void => {
  const raw = readSecretsForUpdate();
  if (raw === null) {
    return;
  }
  writeSecretsFile(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== key)));
};
