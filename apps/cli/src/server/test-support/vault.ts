import type { Host, Launch } from "../host";
import { openVault } from "../vault/vault";
import type { VaultProblem } from "../vault/vault";

const unasked = (): never => {
  throw new Error("the vault asks the shell no such thing");
};

type Keep = (name: string, value: string | null) => Promise<void>;

const hostKeeping = (keep: Keep): Host => ({
  checkUpdate: unasked,
  copyText: unasked,
  installUpdate: unasked,
  keepAwake: unasked,
  loginItem: unasked,
  messageBox: unasked,
  notify: unasked,
  open: unasked,
  relaunch: unasked,
  tray: unasked,
  vaultDelete: (name) => keep(name, null),
  vaultSet: (name, value) => keep(name, value),
});

const launchOf = (packaged: boolean, vault: Launch["vault"]): Launch => ({
  openedAtLogin: false,
  packaged,
  pageDevUrl: null,
  vault,
});

interface StandInKeychain {
  /** False when it would not list IdleBiz's items at all. */
  listed?: boolean;
  keys?: Record<string, string>;
  refused?: string[];
  /** Why it refuses every change, or null to keep each. */
  refusing?: string | null;
}

/**
 * Opens the vault as a packaged launch does, over a stand-in Keychain holding `keys` and refusing to
 * give `refused`: what the shell would have read at hello. `calls` is each change it kept, a
 * deleted name's value null.
 */
export const keychainVault = ({
  listed = true,
  keys = {},
  refused = [],
  refusing = null,
}: StandInKeychain = {}) => {
  const calls: [name: string, value: string | null][] = [];
  const host = hostKeeping((name, value) => {
    if (refusing !== null) {
      return Promise.reject(new Error(refusing));
    }
    calls.push([name, value]);
    return Promise.resolve();
  });
  const problem = openVault(launchOf(true, listed ? { keys, refused } : null), host);
  return { calls, problem };
};

/** Opens the vault as a development launch does: the save's vault.json. */
export const fileVault = (): VaultProblem | null =>
  openVault(launchOf(false, null), hostKeeping(unasked));
