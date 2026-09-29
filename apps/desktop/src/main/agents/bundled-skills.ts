import path from "node:path";
import { app } from "electron";

/**
 * IdleBiz's own skills, laid out as `SessionSetup` says. Beside the asar when packaged, since
 * the claude CLI cannot read inside it; inside the .app or the checkout either way, which no run
 * writes.
 */
export const bundledSkillsDir = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "skills")
    : path.join(app.getAppPath(), "resources", "skills");
