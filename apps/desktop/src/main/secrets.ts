import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "@/main/paths";

// ---------------------------------------------------------------------------
// Founder-managed secrets at ~/.idlebiz/secrets.json (mode 0600). Values are
// exported into the main process env at boot so every agent's shell — and the
// real-metrics providers — can use them. Single-user machine, founder's own
// keys; agents are told these exist and what they're for.
// ---------------------------------------------------------------------------

const SECRETS_PATH = join(ROOT_DIR, "secrets.json");

function loadSecrets(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Export secrets as env vars (inherited by agents' shells) and return them. */
export function exportSecretsToEnv(): Record<string, string> {
  if (!existsSync(SECRETS_PATH)) {
    // seed an empty, documented file so the founder knows where keys go
    try {
      writeFileSync(
        SECRETS_PATH,
        JSON.stringify(
          {
            _readme:
              "Founder secrets. String values are exported as env vars to your employees and the metrics providers. e.g. STRIPE_SECRET_KEY, PLAUSIBLE_API_KEY.",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
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
  const raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
    if (parsed && typeof parsed === "object") Object.assign(raw, parsed);
  } catch {
    /* fresh file */
  }
  raw[key] = value;
  writeFileSync(SECRETS_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 });
  if (!key.startsWith("_")) process.env[key] = value;
}

export function deleteSecret(key: string): void {
  const raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
    if (parsed && typeof parsed === "object") Object.assign(raw, parsed);
  } catch {
    return;
  }
  delete raw[key];
  writeFileSync(SECRETS_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 });
  delete process.env[key];
}
