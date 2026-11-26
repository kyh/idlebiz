import { Entry, findCredentials } from "@napi-rs/keyring";
import { shellLog } from "./shell-log";

const SERVICE = "IdleBiz";

/**
 * The vault's keys, one generic-password item each in the login keychain, service "IdleBiz",
 * account the key's name, read at hello; `null` for a development build, which keeps its keys in a
 * file under its save, or when the Keychain would not list them, which main then says.
 */
export const openVault = (packaged: boolean) => {
  if (!packaged) {
    return null;
  }

  try {
    const keys: Record<string, string> = {};

    for (const { account, password } of findCredentials(SERVICE)) {
      keys[account] = password;
    }

    shellLog(`the Keychain gave IdleBiz ${Object.keys(keys).length} of its keys`);

    return { keys, refused: [] };
  } catch (error) {
    shellLog(`the Keychain would not give IdleBiz its keys: ${String(error)}`);

    return null;
  }
};

/** Keeps `value` under `name`, in place of any value it had. */
export const vaultSet = (name: string, value: string) => {
  try {
    new Entry(SERVICE, name).setPassword(value);
  } catch (error) {
    throw new Error(`the Keychain would not keep ${name}: ${String(error)}`, { cause: error });
  }
};

/** Forgets `name`; one the vault never held is already forgotten. */
export const vaultDelete = (name: string) => {
  try {
    new Entry(SERVICE, name).deletePassword();
  } catch (error) {
    throw new Error(`the Keychain would not forget ${name}: ${String(error)}`, { cause: error });
  }
};
