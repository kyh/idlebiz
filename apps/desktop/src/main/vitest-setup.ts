import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Before any test file loads: one that imports @/main/paths ahead of pointing IDLEBIZ_ROOT_DIR at
// its own root would otherwise boot, adopt and write the founder's real save in ~/.idlebiz.
process.env.IDLEBIZ_ROOT_DIR ??= mkdtempSync(path.join(tmpdir(), "idlebiz-test-root-"));
