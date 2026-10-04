import path from "node:path";
import { launch } from "@/main/host";

/**
 * IdleBiz's own skills, laid out as `SessionSetup` says: in the bundle's resources when packaged,
 * the checkout's `resources/` in dev. Inside the .app or the checkout either way, which no run
 * writes.
 */
export const bundledSkillsDir = (): string => path.join(launch().resourcesDir, "skills");
