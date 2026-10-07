// Every module lands flat in dist/ (index.js, or a chunk beside it), so `import.meta.url` names a
// file in dist/ there and this file here; the same `../` reaches the package root from both only
// because this file sits one level under it. As kyh/inteligir's CLI finds its own.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packageRootUrl = new URL("../", import.meta.url);

const manifestSchema = z.looseObject({ version: z.string() });

/** A file of this package's own: what it ships (`dist/`, `resources/`), read where it is. */
export const packageFile = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, packageRootUrl));

export const readCliVersion = (): string => {
  try {
    const manifest = manifestSchema.safeParse(
      JSON.parse(readFileSync(new URL("package.json", packageRootUrl), "utf-8")),
    );
    if (manifest.success) {
      return manifest.data.version;
    }
  } catch {
    // fall through to the placeholder
  }
  return "0.0.0";
};
