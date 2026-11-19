import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packageRootUrl = new URL("../", import.meta.url);

const manifestSchema = z.looseObject({ version: z.string() });

/** A file of this package's own: what it ships (`dist/`, `resources/`), read where it is. */
export const packageFile = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, packageRootUrl));

export const readCliVersion = () => {
  try {
    const manifest = manifestSchema.safeParse(
      JSON.parse(readFileSync(new URL("package.json", packageRootUrl), "utf-8")),
    );

    return manifest.success ? manifest.data.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};
