import { spawnSync } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const ENTITLEMENTS = path.join(packageRoot, "resources", "entitlements.mac.plist");

const MACH_O_MAGIC = new Set([
  0xfe_ed_fa_ce, 0xfe_ed_fa_cf, 0xce_fa_ed_fe, 0xcf_fa_ed_fe, 0xca_fe_ba_be, 0xbe_ba_fe_ca,
  0xca_fe_ba_bf, 0xbf_ba_fe_ca,
]);

const isMachO = async (file: string) => {
  const handle = await open(file, "r");

  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);

    return bytesRead === 4 && MACH_O_MAGIC.has(buffer.readUInt32BE(0));
  } finally {
    await handle.close();
  }
};

const machOsUnder = async (dir: string) => {
  const found: string[] = [];

  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);

      if (await isMachO(file)) {
        found.push(file);
      }
    }
  }

  return found;
};

export const signResources = async (
  dirs: readonly string[],
  identity: string,
  hardened: boolean,
) => {
  const options = hardened ? ["--options", "runtime", "--timestamp"] : [];
  let signed = 0;

  for (const dir of dirs) {
    for (const file of await machOsUnder(dir)) {
      const result = spawnSync(
        "codesign",
        ["--force", "--sign", identity, ...options, "--entitlements", ENTITLEMENTS, file],
        { encoding: "utf-8" },
      );

      if (result.status !== 0) {
        throw new Error(`codesign refused ${file}:\n${result.stderr}`);
      }

      signed += 1;
    }
  }

  return signed;
};
