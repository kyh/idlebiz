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

/** Where a development launch keeps its keys, which no run reads or writes. */
export const vaultFile = () => path.join(rootDir(), "vault.json");

const KEYCHAIN = 'the login keychain, under "IdleBiz"';

const README = `A development launch's keys (${SECRET_NAMES.join(", ")}), as plain text: the installed IdleBiz keeps them in the macOS Keychain instead. IdleBiz uses them itself for its reads, deploys, payment links and print listings; they are never given to your employees. Enter them in the app (Vercel: a product's Vercel button, under users; Stripe and Printful: the Budget panel), or paste one here. Each ENV/<product>/<project>/<NAME> is a value your team set on that product's Vercel project, kept so a deploy can refuse a folder that holds it.`;

interface Store {
  read: () => ReadonlyMap<SecretKey, string>;
  refused: ReadonlySet<SecretKey>;
  set: (name: SecretKey, value: string) => Promise<void>;
  delete: (name: SecretKey) => Promise<void>;
}

interface FileKeys {
  keys: Map<SecretKey, string>;
  rest: JsonRecord;
}

const keySchema = z.string().min(1);

const fileSchema = jsonRecordSchema.transform((raw) => {
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

const writeFile = ({ keys, rest }: FileKeys) => {
  writeJsonFile(
    vaultFile(),
    { ...rest, ...Object.fromEntries(keys) },
    { durable: true, mode: 0o600 },
  );
};

const changeFile = (change: (keys: Map<SecretKey, string>) => void) => {
  const file = readJsonFileForUpdate(vaultFile(), fileSchema) ?? { keys: new Map(), rest: {} };
  change(file.keys);
  writeFile(file);

  return Promise.resolve();
};

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

const keychainStore = (
  host: Host,
  held: ReadonlyMap<SecretKey, string>,
  unread: readonly SecretKey[],
) => {
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
  } satisfies Store;
};

let store: Store = fileStore;

interface VaultProblem {
  where: string;
  cause: Error;
}

const keychainProblem = (launch: Launch) => {
  if (launch.vault === null) {
    return {
      cause: new Error(
        "The Keychain would not list IdleBiz's keys, so IdleBiz holds none this launch. Quit and open IdleBiz again, or enter each again in the app.",
      ),
      where: KEYCHAIN,
    } satisfies VaultProblem | null;
  }

  const refused = launch.vault.refused.filter(isSecretKey);

  return (
    refused.length === 0
      ? null
      : {
          cause: new Error(
            `The Keychain would not give IdleBiz ${refused.join(", ")}. Enter each again in the app.`,
          ),
          where: KEYCHAIN,
        }
  ) satisfies VaultProblem | null;
};

/**
 * Opens this launch's vault: the Keychain's keys the shell read at hello, or a development launch's
 * file, seeded with what it is when missing. Returns why it holds less than it should.
 */
export const openVault = (launch: Launch, host: Host) => {
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
    return {
      cause: error instanceof Error ? error : new Error(String(error)),
      where: vaultFile(),
    } satisfies VaultProblem | null;
  }
};

export const getSecret = (key: SecretKey) => store.read().get(key) ?? null;

/** Whether the vault holds `key` at all, even one the Keychain would not give this launch. */
export const hasSecret = (key: SecretKey) => store.read().has(key) || store.refused.has(key);

/** Every key under a name starting with `prefix`, keyed by the rest of the name. */
export const secretsUnder = (prefix: string) =>
  new Map<string, string>(
    [...store.read()].flatMap<[string, string]>(([name, value]) =>
      name.startsWith(prefix) ? [[name.slice(prefix.length), value]] : [],
    ),
  );

const kept = async (change: () => Promise<void>, key: SecretKey) => {
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

export const deleteSecret = async (key: SecretKey) => {
  await kept(() => store.delete(key), key);
};

/** Keeps `value` under `key`; a blank one is no key, so it forgets the key. Refused as the founder reads it. */
export const setSecret = async (key: SecretKey, value: string) => {
  if (value === "") {
    await deleteSecret(key);

    return;
  }

  await kept(() => store.set(key, value), key);
};

/** Forgets every key, as a reset does. */
export const clearVault = async () => {
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

export const MIN_SECRET_LENGTH = 8;

/**
 * Every key IdleBiz itself uses (Stripe's, Vercel's, Printful's…), by name: never a value set_env
 * set, which a run may know. None of these may reach a run, a reply to one, a variable it sets
 * or a folder it deploys.
 */
export const heldKeys = () =>
  [...store.read()].flatMap<HeldKey>(([name, value]) =>
    !name.startsWith(ENV_PREFIX) && value.length >= MIN_SECRET_LENGTH
      ? [{ kind: "held", name, value }]
      : [],
  );

/** The name of a key IdleBiz holds whose value `text` carries, or null. */
export const heldKeyIn = (text: string) =>
  heldKeys().find(({ value }) => text.includes(value))?.name ?? null;
