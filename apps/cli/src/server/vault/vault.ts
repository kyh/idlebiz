import path from "node:path";
import { z } from "zod";
import type { Host, Launch } from "../host";
import { readJsonFile, readJsonFileForUpdate, writeJsonFile } from "../lib/fs";
import { rootDir } from "../paths";
import { RefusalError } from "../refusal";
import { jsonRecordSchema } from "@repo/domain/json";
import type { JsonRecord } from "@repo/domain/json";
import { ENV_PREFIX, SECRET_NAMES, isSecretKey } from "./names";
import type { SecretKey } from "./names";

// The vault keeps IdleBiz's keys in main: each is read where it is used, and no employee's
// environment ever carries one. A packaged app's are the Keychain's, one item each, which the
// shell reads at hello and keeps each change of over the relay, so main holds a copy it reads
// synchronously. A development launch keeps them in a file under its save instead, since an
// ad-hoc-signed shell would meet a Keychain prompt after every rebuild.

/** Where a development launch keeps its keys, which no run reads or writes. */
export const vaultFile = (): string => path.join(rootDir(), "vault.json");

/** Where the packaged app's keys are, as the founder finds them in Keychain Access. */
const KEYCHAIN = 'the login keychain, under "IdleBiz"';

const README = `A development launch's keys (${SECRET_NAMES.join(", ")}), as plain text: the installed IdleBiz keeps them in the macOS Keychain instead. IdleBiz uses them itself for its reads, deploys, payment links and print listings; they are never given to your employees. Enter them in the app (Vercel: a product's Vercel button, under users; Stripe and Printful: the Budget panel), or paste one here. Each ENV/<product>/<project>/<NAME> is a value your team set on that product's Vercel project, kept so a deploy can refuse a folder that holds it.`;

/** Where keys are kept: each reads them all at once and keeps a change before it answers. */
interface Store {
  read: () => ReadonlyMap<SecretKey, string>;
  /** Keys the vault holds but would not give this launch, which are still the founder's. */
  refused: ReadonlySet<SecretKey>;
  set: (name: SecretKey, value: string) => Promise<void>;
  delete: (name: SecretKey) => Promise<void>;
}

/** The file's keys, and the rest (the _readme, any other note, a value not text or blank) as it was. */
interface FileKeys {
  keys: Map<SecretKey, string>;
  rest: JsonRecord;
}

// a value that is no text, or blank, is no key: it is kept as the founder wrote it
const keySchema = z.string().min(1);

const fileSchema = jsonRecordSchema.transform((raw): FileKeys => {
  const file: FileKeys = { keys: new Map(), rest: {} };
  for (const [name, value] of Object.entries(raw)) {
    const key = keySchema.safeParse(value);
    if (isSecretKey(name) && key.success) {
      file.keys.set(name, key.data);
    } else {
      file.rest[name] = value;
    }
  }
  return file;
});

const writeFile = ({ keys, rest }: FileKeys): void => {
  // durable: a key lost to an OS crash is one the founder has to find and paste again
  writeJsonFile(
    vaultFile(),
    { ...rest, ...Object.fromEntries(keys) },
    { durable: true, mode: 0o600 },
  );
};

/** Changes the file as `change` does to its keys; one the founder broke by hand is refused, not overwritten. */
const changeFile = (change: (keys: Map<SecretKey, string>) => void): Promise<void> => {
  const file = readJsonFileForUpdate(vaultFile(), fileSchema) ?? { keys: new Map(), rest: {} };
  change(file.keys);
  writeFile(file);
  return Promise.resolve();
};

/** A development launch's: read from the file each time, so a key pasted there is used at once. */
const fileStore: Store = {
  delete: (name) =>
    changeFile((keys) => {
      keys.delete(name);
    }),
  read: () => readJsonFile(vaultFile(), fileSchema)?.keys ?? new Map(),
  refused: new Set(),
  set: (name, value) =>
    changeFile((keys) => {
      keys.set(name, value);
    }),
};

/** The packaged app's: the Keychain, through the shell, and the copy it read at hello. */
const keychainStore = (
  host: Host,
  held: ReadonlyMap<SecretKey, string>,
  unread: readonly SecretKey[],
): Store => {
  const copy = new Map(held);
  const refused = new Set(unread);
  return {
    delete: async (name) => {
      await host.vaultDelete(name);
      copy.delete(name);
      refused.delete(name);
    },
    read: () => copy,
    refused,
    set: async (name, value) => {
      await host.vaultSet(name, value);
      copy.set(name, value);
      refused.delete(name);
    },
  };
};

let store: Store = fileStore;

/** Why the vault holds less than it should, as boot names it beside the save's notes. */
export interface VaultProblem {
  where: string;
  cause: Error;
}

const keychainProblem = (launch: Launch): VaultProblem | null => {
  if (launch.vault === null) {
    return {
      cause: new Error(
        "The Keychain would not list IdleBiz's keys, so IdleBiz holds none this launch. Quit and open IdleBiz again, or enter each again in the app.",
      ),
      where: KEYCHAIN,
    };
  }
  const refused = launch.vault.refused.filter(isSecretKey);
  return refused.length === 0
    ? null
    : {
        cause: new Error(
          `The Keychain would not give IdleBiz ${refused.join(", ")}. Enter each again in the app.`,
        ),
        where: KEYCHAIN,
      };
};

/**
 * Opens this launch's vault: the Keychain's keys the shell read at hello, or a development launch's
 * file, seeded with what it is when missing. Returns why it holds less than it should.
 */
export const openVault = (launch: Launch, host: Host): VaultProblem | null => {
  if (launch.packaged) {
    const held = Object.entries(launch.vault?.keys ?? {}).filter(
      (entry): entry is [SecretKey, string] => isSecretKey(entry[0]),
    );
    store = keychainStore(host, new Map(held), launch.vault?.refused.filter(isSecretKey) ?? []);
    return keychainProblem(launch);
  }
  store = fileStore;
  try {
    if (readJsonFileForUpdate(vaultFile(), fileSchema) === null) {
      writeFile({ keys: new Map(), rest: { _readme: README } });
    }
    return null;
  } catch (error) {
    return { cause: error instanceof Error ? error : new Error(String(error)), where: vaultFile() };
  }
};

export const getSecret = (key: SecretKey): string | null => store.read().get(key) ?? null;

/** Whether the vault holds `key` at all, even one the Keychain would not give this launch. */
export const hasSecret = (key: SecretKey): boolean =>
  store.read().has(key) || store.refused.has(key);

/** Every key under a name starting with `prefix`, keyed by the rest of the name. */
export const secretsUnder = (prefix: string): Map<string, string> =>
  new Map(
    [...store.read()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, value]) => [name.slice(prefix.length), value]),
  );

const kept = async (change: () => Promise<void>, key: SecretKey): Promise<void> => {
  try {
    await change();
  } catch (error) {
    if (error instanceof RefusalError) {
      throw error;
    }
    throw new RefusalError(
      `IdleBiz could not keep ${key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const deleteSecret = async (key: SecretKey): Promise<void> => {
  await kept(() => store.delete(key), key);
};

/** Keeps `value` under `key`; a blank one is no key, so it forgets the key. Refused as the founder reads it. */
export const setSecret = async (key: SecretKey, value: string): Promise<void> => {
  if (value === "") {
    await deleteSecret(key);
    return;
  }
  await kept(() => store.set(key, value), key);
};

/** Forgets every key, as a reset does. */
export const clearVault = async (): Promise<void> => {
  for (const name of [...store.read().keys(), ...store.refused]) {
    await deleteSecret(name);
  }
};

/** A key IdleBiz itself uses, which never leaves main. */
export interface HeldKey {
  kind: "held";
  name: string;
  value: string;
}

// a flag or a port turns up in any text, and no key is this short
export const MIN_SECRET_LENGTH = 8;

/**
 * Every key IdleBiz itself uses (Stripe's, Vercel's, Printful's…), by name: never a value set_env
 * set, which a run may know. None of these may reach a run, a reply to one, a variable it sets
 * or a folder it deploys.
 */
export const heldKeys = (): HeldKey[] =>
  [...store.read()]
    .filter(([name, value]) => !name.startsWith(ENV_PREFIX) && value.length >= MIN_SECRET_LENGTH)
    .map(([name, value]) => ({ kind: "held", name, value }));

/** The name of a key IdleBiz holds whose value `text` carries, or null. */
export const heldKeyIn = (text: string): string | null =>
  heldKeys().find(({ value }) => text.includes(value))?.name ?? null;
