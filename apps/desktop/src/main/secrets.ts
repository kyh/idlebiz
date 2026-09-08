import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile } from "@/main/lib/fs";
import { ROOT_DIR } from "@/main/paths";
import { jsonRecordSchema } from "@/shared/json";
import type { JsonRecord } from "@/shared/json";

// Founder secrets use mode 0600 and reach agents through their inherited environment.

const SECRETS_PATH = path.join(ROOT_DIR, "secrets.json");

const readSecretsFile = (): JsonRecord | null => readJsonFile(SECRETS_PATH, jsonRecordSchema);

const writeSecretsFile = (raw: JsonRecord): void =>
  atomicWrite(SECRETS_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 });

const loadSecrets = (): Record<string, string> => {
  const file = readSecretsFile() ?? {};
  return Object.fromEntries(
    Object.entries(file).filter(
      (entry): entry is [string, string] => z.string().safeParse(entry[1]).success,
    ),
  );
};

export const exportSecretsToEnv = (): Record<string, string> => {
  if (!existsSync(SECRETS_PATH)) {
    // seed an empty, documented file so the founder knows where keys go
    try {
      writeSecretsFile({
        _readme:
          "Founder secrets. String values are exported as env vars to your employees and the metrics providers. e.g. STRIPE_SECRET_KEY, PLAUSIBLE_API_KEY.",
      });
    } catch {
      /* best effort */
    }
    return {};
  }
  const secrets = loadSecrets();
  for (const [k, v] of Object.entries(secrets)) {
    if (!k.startsWith("_")) {
      process.env[k] = v;
    }
  }
  return secrets;
};

export const getSecret = (key: string): string | null => loadSecrets()[key] ?? null;

export const setSecret = (key: string, value: string): void => {
  const raw = readSecretsFile() ?? {};
  raw[key] = value;
  writeSecretsFile(raw);
  if (!key.startsWith("_")) {
    process.env[key] = value;
  }
};

export const deleteSecret = (key: string): void => {
  const raw = readSecretsFile();
  if (raw === null) {
    return;
  }
  writeSecretsFile(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== key)));
  // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
  delete process.env[key];
};
