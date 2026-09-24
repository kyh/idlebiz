import path from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile, readJsonFileForUpdate } from "@/main/lib/fs";
import { guarded } from "@/main/lib/report";
import { ROOT_DIR } from "@/main/paths";
import { jsonRecordSchema } from "@/shared/json";
import type { JsonRecord } from "@/shared/json";

// Founder secrets use mode 0600 and stay in main: IdleBiz reads each where it uses it, and
// no employee's environment ever carries one. Employees still run as the founder's OS user
// and can read the file, so each value is sealed with a key the Keychain keeps for this app.

const SECRETS_PATH = path.join(ROOT_DIR, "secrets.json");

export const STRIPE_CONNECT_TOKEN = "STRIPE_CONNECT_TOKEN";
export const STRIPE_SECRET_KEY = "STRIPE_SECRET_KEY";

/** Marks a value the sealer encrypted, as base64; a different scheme takes a new version. */
const SEALED = "sealed:v1:";

const README =
  "Founder secrets, e.g. STRIPE_SECRET_KEY, VERCEL_TOKEN, sealed with the macOS Keychain. IdleBiz uses them itself for its reads, deploys and payment links; they are never given to your employees. Enter them in the app (Vercel: a product's Vercel button, under users; Stripe: the Budget panel, under revenue). A key pasted here as plain text is sealed the next time IdleBiz reads this file.";

/** Encrypts a value for the file and decrypts it back; main's wraps Electron's safeStorage. */
export interface Sealer {
  seal: (plain: string) => Buffer;
  open: (sealed: Buffer) => string;
}

let sealer: Sealer | null = null;

/** Main sets one once the Keychain is up; until then values are written and read as plain text. */
export const setSealer = (next: Sealer | null): void => {
  sealer = next;
};

/** A key's value exactly as the file holds it: pasted as plain text, or sealed. */
interface Held {
  kind: "plain" | "sealed";
  text: string;
}

const heldSchema = z
  .string()
  .transform((text): Held => ({ kind: text.startsWith(SEALED) ? "sealed" : "plain", text }));

/** The file's keys, and the rest (the _readme, any other _note, any value not text) kept as it was. */
interface Secrets {
  keys: Map<string, Held>;
  rest: JsonRecord;
}

const secretsSchema = jsonRecordSchema.transform((raw): Secrets => {
  const secrets: Secrets = { keys: new Map(), rest: {} };
  for (const [name, value] of Object.entries(raw)) {
    const held = heldSchema.safeParse(value);
    if (held.success && !name.startsWith("_")) {
      secrets.keys.set(name, held.data);
    } else {
      secrets.rest[name] = value;
    }
  }
  return secrets;
});

/** The value as plain text; null when it is sealed and this app can't open it. */
const opened = (held: Held): string | null => {
  if (held.kind === "plain") {
    return held.text;
  }
  try {
    return sealer?.open(Buffer.from(held.text.slice(SEALED.length), "base64")) ?? null;
  } catch {
    return null;
  }
};

/** What the file holds for a key: sealed once a sealer is set; one this app can't open, as it was. */
const stored = (held: Held): string =>
  held.kind === "plain" && sealer
    ? `${SEALED}${sealer.seal(held.text).toString("base64")}`
    : held.text;

const readSecretsForUpdate = (): Secrets | null =>
  readJsonFileForUpdate(SECRETS_PATH, secretsSchema);

const writeSecretsFile = ({ keys, rest }: Secrets): void => {
  const file = {
    ...rest,
    ...Object.fromEntries([...keys].map(([name, held]) => [name, stored(held)])),
  };
  atomicWrite(SECRETS_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
};

/** Seal what the founder pasted by hand; only a file that parsed gets here, so none is lost. */
const sealPasted = (secrets: Secrets): void => {
  if (sealer && [...secrets.keys.values()].some((held) => held.kind === "plain")) {
    guarded("seal secrets.json", () => writeSecretsFile(secrets));
  }
};

/**
 * Seeds a documented file where there is none, so the founder knows where keys go, and seals
 * the keys pasted into one; returns what boot reports when secrets.json, or a key in it,
 * can't be read.
 */
export const checkSecrets = (): { file: string; cause: unknown } | null => {
  let secrets: Secrets | null;
  try {
    secrets = readSecretsForUpdate();
  } catch (error) {
    return { cause: error, file: SECRETS_PATH };
  }
  if (secrets === null) {
    try {
      writeSecretsFile({ keys: new Map(), rest: { _readme: README } });
    } catch {
      /* best effort */
    }
    return null;
  }
  sealPasted(secrets);
  const shut = [...secrets.keys].filter(([, held]) => opened(held) === null).map(([name]) => name);
  if (shut.length === 0) {
    return null;
  }
  const why = sealer
    ? "sealed by another build of IdleBiz, or Keychain access was denied"
    : "this launch of IdleBiz isn't using the macOS Keychain";
  return {
    cause: new Error(
      `IdleBiz can't open ${shut.join(", ")} (${why}). Enter each again in the app, or paste it into this file as plain text.`,
    ),
    file: SECRETS_PATH,
  };
};

export const getSecret = (key: string): string | null => {
  const secrets = readJsonFile(SECRETS_PATH, secretsSchema);
  if (secrets === null) {
    return null;
  }
  sealPasted(secrets);
  const held = secrets.keys.get(key);
  return held ? opened(held) : null;
};

export const setSecret = (key: string, value: string): void => {
  const secrets = readSecretsForUpdate() ?? { keys: new Map(), rest: {} };
  secrets.keys.set(key, { kind: "plain", text: value });
  writeSecretsFile(secrets);
};

export const deleteSecret = (key: string): void => {
  const secrets = readSecretsForUpdate();
  if (secrets === null) {
    return;
  }
  secrets.keys.delete(key);
  writeSecretsFile(secrets);
};
