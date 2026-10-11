import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { atomicWrite, readJsonFile, readJsonFileForUpdate } from "./lib/fs";
import { guarded } from "./lib/report";
import { ROOT_DIR } from "./paths";
import { jsonRecordSchema } from "@repo/domain/json";
import type { JsonRecord } from "@repo/domain/json";

// Founder secrets use mode 0600 and stay in main: IdleBiz reads each where it uses it, and
// no employee's environment ever carries one. Employees run as the founder's OS user; their
// sandbox keeps them from the file, and each value is also sealed with a key the Keychain keeps
// for this app, since a claude run can still reach the Keychain.

export const SECRETS_PATH = path.join(ROOT_DIR, "secrets.json");

export const STRIPE_SECRET_KEY = "STRIPE_SECRET_KEY";
export const VERCEL_TOKEN = "VERCEL_TOKEN";
export const PRINTFUL_TOKEN = "PRINTFUL_TOKEN";
/** Every key IdleBiz itself uses, by name: a misspelt one would read as no key and quietly turn its feature off. */
const SECRET_NAMES = [STRIPE_SECRET_KEY, VERCEL_TOKEN, PRINTFUL_TOKEN] as const;
type SecretName = (typeof SECRET_NAMES)[number];
/** Where main keeps the values set_env set, one key each. */
export const ENV_PREFIX = "ENV/";
export type EnvSecretName = `${typeof ENV_PREFIX}${string}`;
type SecretKey = SecretName | EnvSecretName;

/** Marks a sealed value; a value of a scheme this build doesn't know reads as one it can't open. */
const SEALED = "sealed:";
/** AES-256-GCM's nonce, ciphertext and tag, as base64; a different scheme takes a new version. */
const SEALED_V2 = `${SEALED}v2:`;

const README = `Founder secrets (${SECRET_NAMES.join(", ")}), sealed with a key the macOS Keychain keeps for IdleBiz. IdleBiz uses them itself for its reads, deploys, payment links and print listings; they are never given to your employees. Enter them in the app (Vercel: a product's Vercel button, under users; Stripe and Printful: the Budget panel). A key pasted here as plain text is sealed the next time IdleBiz reads this file. Each ENV/<product>/<project>/<NAME> is a value your team set on that product's Vercel project, kept so a deploy can refuse a folder that holds it.`;

/**
 * Encrypts a value for the file and decrypts it back, bound to the name it is kept under, so a
 * value moved to another name opens as nothing. Main's is AES-256-GCM (`sealerFor`).
 */
export interface Sealer {
  seal: (plain: string, name: string) => Buffer;
  open: (sealed: Buffer, name: string) => string;
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CIPHER = "aes-256-gcm";

/** The key main seals with, as the shell hands it at hello: 32 bytes, base64. */
export const sealingKeySchema = z
  .base64()
  .transform((text) => Buffer.from(text, "base64"))
  .refine((key) => key.length === KEY_BYTES, `a sealing key is ${KEY_BYTES} bytes`)
  .brand<"SealingKey">();
type SealingKey = z.infer<typeof sealingKeySchema>;

/**
 * What every unpackaged launch seals with, so no dev shell touches the Keychain: an ad-hoc signed
 * build would be asked again after every rebuild. It is no secret, and only dev opens what it
 * seals.
 */
export const DEV_SECRETS_KEY = sealingKeySchema.parse(
  Buffer.alloc(KEY_BYTES, "idlebiz dev").toString("base64"),
);

export const sealerFor = (key: SealingKey): Sealer => ({
  open: (sealed, name) => {
    if (sealed.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error("the sealed value is too short to hold a nonce and a tag");
    }
    const decipher = createDecipheriv(CIPHER, key, sealed.subarray(0, NONCE_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(name, "utf-8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf-8");
  },
  seal: (plain, name) => {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(name, "utf-8"));
    const ciphertext = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
  },
});

let sealer: Sealer | null = null;

/** Main sets one once it has a key; until then values are written and read as plain text. */
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
const opened = (name: string, held: Held): string | null => {
  if (held.kind === "plain") {
    return held.text;
  }
  if (sealer === null || !held.text.startsWith(SEALED_V2)) {
    return null;
  }
  try {
    return sealer.open(Buffer.from(held.text.slice(SEALED_V2.length), "base64"), name);
  } catch {
    return null;
  }
};

/** What the file holds for a key: sealed once a sealer is set; one this app can't open, as it was. */
const stored = (name: string, held: Held): string =>
  held.kind === "plain" && sealer
    ? `${SEALED_V2}${sealer.seal(held.text, name).toString("base64")}`
    : held.text;

const readSecretsForUpdate = (): Secrets | null =>
  readJsonFileForUpdate(SECRETS_PATH, secretsSchema);

const writeSecretsFile = ({ keys, rest }: Secrets): void => {
  const file = {
    ...rest,
    ...Object.fromEntries([...keys].map(([name, held]) => [name, stored(name, held)])),
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
  const shut = [...secrets.keys]
    .filter(([name, held]) => opened(name, held) === null)
    .map(([name]) => name);
  if (shut.length === 0) {
    return null;
  }
  const why = sealer
    ? "sealed by another build of IdleBiz, or Keychain access was denied"
    : "this launch of IdleBiz isn't using the macOS Keychain";
  const teamSet = shut.some((name) => name.startsWith(ENV_PREFIX))
    ? ` Each ${ENV_PREFIX} value is one your team set with set_env, which sets it again.`
    : "";
  return {
    cause: new Error(
      `IdleBiz can't open ${shut.join(", ")} (${why}). Enter each again in the app, or paste it into this file as plain text.${teamSet}`,
    ),
    file: SECRETS_PATH,
  };
};

export const getSecret = (key: SecretKey): string | null => {
  const secrets = readJsonFile(SECRETS_PATH, secretsSchema);
  if (secrets === null) {
    return null;
  }
  sealPasted(secrets);
  const held = secrets.keys.get(key);
  return held ? opened(key, held) : null;
};

/** Whether the file holds `key` at all, opened or not. */
export const hasSecret = (key: SecretKey): boolean =>
  readJsonFile(SECRETS_PATH, secretsSchema)?.keys.has(key) ?? false;

/** Every value this app can open under a name starting with `prefix`, keyed by the rest of the name. */
export const secretsUnder = (prefix: string): Map<string, string> => {
  const secrets = readJsonFile(SECRETS_PATH, secretsSchema);
  const out = new Map<string, string>();
  for (const [name, held] of secrets?.keys ?? []) {
    const value = name.startsWith(prefix) ? opened(name, held) : null;
    if (value !== null) {
      out.set(name.slice(prefix.length), value);
    }
  }
  return out;
};

/** A key IdleBiz itself uses, which never leaves main. */
export interface HeldKey {
  kind: "held";
  name: string;
  value: string;
}

// a flag or a port turns up in any text, and no key is this short
const MIN_KEY_LENGTH = 8;

/**
 * Every key IdleBiz itself uses (Stripe's, Vercel's, Printful's…), by name: never a value set_env
 * set, which a run may know. None of these may reach a run, a reply to one, a variable it sets
 * or a folder it deploys.
 */
export const heldKeys = (): HeldKey[] =>
  [...secretsUnder("")]
    .filter(([name, value]) => !name.startsWith(ENV_PREFIX) && value.length >= MIN_KEY_LENGTH)
    .map(([name, value]) => ({ kind: "held", name, value }));

/** The name of a key IdleBiz holds whose value `text` carries, or null. */
export const heldKeyIn = (text: string): string | null =>
  heldKeys().find(({ value }) => text.includes(value))?.name ?? null;

export const setSecret = (key: SecretKey, value: string): void => {
  const secrets = readSecretsForUpdate() ?? { keys: new Map(), rest: {} };
  secrets.keys.set(key, { kind: "plain", text: value });
  writeSecretsFile(secrets);
};

export const deleteSecret = (key: SecretKey): void => {
  const secrets = readSecretsForUpdate();
  if (secrets === null) {
    return;
  }
  secrets.keys.delete(key);
  writeSecretsFile(secrets);
};
