import { packageFile } from "../../paths";

/**
 * IdleBiz's own skills, laid out as `SessionSetup` says: this package's `resources/`, in the .app
 * (Contents/Resources/server) or the checkout. Inside the .app or the checkout either way, which no
 * run writes.
 */
export const bundledSkillsDir = (): string => packageFile("resources/skills");
