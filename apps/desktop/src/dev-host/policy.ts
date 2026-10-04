// The page's content security policy is the shell's: `app.security.csp` in
// src-tauri/tauri.conf.json, which Tauri stamps on the bundle's own page as a header. A page Tauri
// does not serve, the dev server's or e2e's, is handed the same policy by whoever serves it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const tauriConfigSchema = z.object({
  app: z.object({ security: z.object({ csp: z.record(z.string(), z.string()) }) }),
});

export interface PolicyOptions {
  /** The desktop package, whose `src-tauri/tauri.conf.json` holds the policy. */
  desktopDir: string;
  /** More origins the page may connect to: the dev server's own socket, for hot reload. */
  connect?: readonly string[];
  /** For a meta tag, which may not carry `frame-ancestors` (a header's alone). */
  meta?: boolean;
}

export const pagePolicy = ({ connect = [], desktopDir, meta = false }: PolicyOptions): string => {
  const config = tauriConfigSchema.parse(
    JSON.parse(readFileSync(path.join(desktopDir, "src-tauri/tauri.conf.json"), "utf-8")),
  );
  return Object.entries(config.app.security.csp)
    .filter(([directive]) => !(meta && directive === "frame-ancestors"))
    .map(([directive, sources]) =>
      directive === "connect-src"
        ? `${directive} ${[sources, ...connect].join(" ")}`
        : `${directive} ${sources}`,
    )
    .join("; ");
};
