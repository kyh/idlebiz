import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";

// Electron fetches its binary the first time something requires it, synchronously, and unpacks it
// into node_modules/electron/dist. Test files that import main-process code (agent-driver through
// bundled-skills, product, the character sheets) require it from every worker at once, and
// concurrent unpacks collide ("failed to create … icudtl.dat: File exists"), failing whichever
// worker lost the race at import. Requiring it once here, before any worker starts, does the
// fetch alone; the workers then find the binary in place. Without it most of main's suites cannot
// import, so a binary that is not there fails here, once, saying how to fix it.
export default function setup(): void {
  const binary = z.string().parse(createRequire(import.meta.url)("electron"));
  if (!existsSync(binary)) {
    throw new Error(
      `Electron's binary is missing at ${binary}. Delete node_modules/electron and run "npx install-electron --no", or reinstall.`,
    );
  }
}
