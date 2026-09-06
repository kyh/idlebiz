import { z } from "zod";

// ECIES: ephemeral P-256 ECDH, HKDF-SHA256, AES-256-GCM. The desktop holds the
// private key for one flow; browser history receives only the sealed account.

const CURVE = "P-256";
/** An uncompressed P-256 point: 0x04 || x || y. */
const RAW_KEY_BYTES = 65;
const IV_BYTES = 12;
const INFO = new TextEncoder().encode("idlebiz stripe-connect v1");

const subtle = globalThis.crypto.subtle;
/** The key type of whichever WebCrypto is ambient: Node's in main, the DOM's under Next's typecheck. */
type CryptoKey = Parameters<typeof subtle.deriveBits>[1];

/** What an envelope can hold: JSON that a zod schema will read back on the other side. */
export type Sealable = Record<string, string | number | boolean | null>;

/** The desktop's half of a flow: publish `publicKey`, keep `privateKey` until the flow ends. */
export interface Keyring {
  /** base64url of the raw public point, as the OAuth state carries it. */
  publicKey: string;
  privateKey: CryptoKey;
}

export const PublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((s) => Buffer.from(s, "base64url").length === RAW_KEY_BYTES, "not a P-256 public key");

export async function newKeyring(): Promise<Keyring> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"]);
  const raw = await subtle.exportKey("raw", pair.publicKey);
  return { publicKey: Buffer.from(raw).toString("base64url"), privateKey: pair.privateKey };
}

/** The AES key both ends arrive at from one private key and the other's public key. */
async function agree(privateKey: CryptoKey, peerRaw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const peer = await subtle.importKey(
    "raw",
    peerRaw,
    { name: "ECDH", namedCurve: CURVE },
    false,
    [],
  );
  const shared = await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A Buffer's bytes on their own ArrayBuffer, the only view WebCrypto's types accept. */
const bytesOf = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);

/** Seal a JSON value to the holder of `recipientPublicKey`: base64url(epk || iv || ciphertext). */
export async function seal(recipientPublicKey: string, payload: Sealable): Promise<string> {
  const recipient = bytesOf(Buffer.from(PublicKeySchema.parse(recipientPublicKey), "base64url"));
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, false, [
    "deriveBits",
  ]);
  const key = await agree(ephemeral.privateKey, recipient);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const epk = await subtle.exportKey("raw", ephemeral.publicKey);
  return Buffer.concat([Buffer.from(epk), Buffer.from(iv), Buffer.from(ciphertext)]).toString(
    "base64url",
  );
}

/** Open and validate an envelope; all decryption and payload failures return null. */
export async function open<T>(
  ring: Keyring,
  sealed: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length <= RAW_KEY_BYTES + IV_BYTES) return null;
  const epk = bytesOf(bytes.subarray(0, RAW_KEY_BYTES));
  const iv = bytes.subarray(RAW_KEY_BYTES, RAW_KEY_BYTES + IV_BYTES);
  const ciphertext = bytes.subarray(RAW_KEY_BYTES + IV_BYTES);
  try {
    const key = await agree(ring.privateKey, epk);
    const plaintext = await subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
