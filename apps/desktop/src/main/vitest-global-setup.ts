import { createRequire } from "node:module";

// Electron fetches its binary the first time something requires it, synchronously, and unpacks it
// into node_modules/electron/dist. Test files that import main-process code (agent-driver through
// bundled-skills, product, the character sheets) require it from every worker at once, and
// concurrent unpacks collide ("failed to create … icudtl.dat: File exists"), failing whichever
// worker lost the race at import. Requiring it once here, before any worker starts, does the
// fetch alone; the workers then find the binary in place.
export default function setup(): void {
  createRequire(import.meta.url)("electron");
}
