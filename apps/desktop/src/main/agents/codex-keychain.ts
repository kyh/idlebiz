import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import type { TomlTable } from "smol-toml";
import { z } from "zod";

const Store = z.object({ cli_auth_credentials_store: z.string().optional() });

const CodexConfig = Store.extend({
  profile: z.string().optional(),
  profiles: z.record(z.string(), Store).optional(),
});

// `auto` picks the Keychain wherever there is one, as on every Mac.
const KEYCHAIN_STORES: ReadonlySet<string> = new Set(["keyring", "auto"]);

export const CODEX_IN_KEYCHAIN =
  'Codex keeps its login in your Keychain, which IdleBiz\'s sandbox closes to codex runs. To use Codex, set cli_auth_credentials_store = "file" in ~/.codex/config.toml, then run codex login in a terminal.';

/** `text` as TOML, or null where codex could not read it either, which it then says itself. */
const tomlOf = (text: string): TomlTable | null => {
  try {
    return parse(text);
  } catch {
    return null;
  }
};

/**
 * Whether the founder's codex keeps its login in the Keychain, which a codex run cannot reach:
 * as its config.toml chooses, the profile that config selects first.
 */
export const codexLoginInKeychain = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> => {
  const moved = env.CODEX_HOME;
  const home = moved === undefined || moved === "" ? path.join(homedir(), ".codex") : moved;
  const text = await readFile(path.join(home, "config.toml"), "utf-8").catch(() => null);
  if (text === null) {
    return false;
  }
  const config = CodexConfig.safeParse(tomlOf(text));
  if (!config.success) {
    return false;
  }
  const { cli_auth_credentials_store: store, profile, profiles } = config.data;
  const chosen =
    profile === undefined ? undefined : profiles?.[profile]?.cli_auth_credentials_store;
  const effective = chosen ?? store;
  return effective !== undefined && KEYCHAIN_STORES.has(effective);
};
