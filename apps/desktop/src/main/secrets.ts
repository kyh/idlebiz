import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile } from "@/main/lib/fs";
import { ROOT_DIR } from "@/main/paths";
import { jsonRecordSchema, type JsonRecord } from "@/shared/json";

// ---------------------------------------------------------------------------
// Founder-managed secrets at ~/.idlebiz/secrets.json (mode 0600). Values are
// exported into the main process env at boot so every agent's shell — and the
// real-metrics providers — can use them. Single-user machine, founder's own
// keys; agents are told these exist and what they're for.
// ---------------------------------------------------------------------------

const SECRETS_PATH = join(ROOT_DIR, "secrets.json");

/** The secrets file parsed as a JSON record; null = unreadable or not an object. */
const readSecretsFile = (): JsonRecord | null => readJsonFile(SECRETS_PATH, jsonRecordSchema);

/** Founder keys are the founder's own: readable by them alone. */
const writeSecretsFile = (raw: JsonRecord): void =>
  atomicWrite(SECRETS_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 });

function loadSecrets(): Record<string, string> {
  const file = readSecretsFile() ?? {};
  return Object.fromEntries(
    Object.entries(file).filter(
      (entry): entry is [string, string] => z.string().safeParse(entry[1]).success,
    ),
  );
}

/** Export secrets as env vars (inherited by agents' shells) and return them. */
export function exportSecretsToEnv(): Record<string, string> {
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
    if (!k.startsWith("_")) process.env[k] = v;
  }
  return secrets;
}

export function getSecret(key: string): string | null {
  return loadSecrets()[key] ?? null;
}

/** Read-modify-write a single secret (file mode 0600) and sync process.env. */
export function setSecret(key: string, value: string): void {
  const raw = readSecretsFile() ?? {};
  raw[key] = value;
  writeSecretsFile(raw);
  if (!key.startsWith("_")) process.env[key] = value;
}

export function deleteSecret(key: string): void {
  const raw = readSecretsFile();
  if (raw === null) return;
  delete raw[key];
  writeSecretsFile(raw);
  delete process.env[key];
}
