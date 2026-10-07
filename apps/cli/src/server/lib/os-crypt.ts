// The sealing Electron's safeStorage did on the Mac, which is Chromium's OSCrypt v10, so every
// value an older IdleBiz sealed in secrets.json opens as it was: a key derived from the Keychain's
// "IdleBiz Safe Storage" password by PBKDF2-HMAC-SHA1 (salt "saltysalt", 1003 rounds, 16 bytes),
// AES-128-CBC with PKCS#7 padding and an IV of 16 spaces, and "v10" before the ciphertext. The shell
// reads the password, since the Keychain answers the signed app and not the node it runs.

import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import type { Sealer } from "../secrets";

const VERSION = Buffer.from("v10");
const SALT = "saltysalt";
const ROUNDS = 1003;
const KEY_BYTES = 16;
const IV = Buffer.alloc(16, " ");
const CIPHER = "aes-128-cbc";

// what Chromium's mock keychain answers, which dev sealed with: an isolated dev save still opens
export const MOCK_KEYCHAIN_PASSWORD = "mock_password";

export const osCryptSealer = (password: string): Sealer => {
  const key = pbkdf2Sync(password, SALT, ROUNDS, KEY_BYTES, "sha1");
  return {
    open: (sealed) => {
      if (!sealed.subarray(0, VERSION.length).equals(VERSION)) {
        throw new Error("the value is not sealed as v10");
      }
      const decipher = createDecipheriv(CIPHER, key, IV);
      return Buffer.concat([
        decipher.update(sealed.subarray(VERSION.length)),
        decipher.final(),
      ]).toString("utf-8");
    },
    seal: (plain) => {
      const cipher = createCipheriv(CIPHER, key, IV);
      return Buffer.concat([VERSION, cipher.update(plain, "utf-8"), cipher.final()]);
    },
  };
};
