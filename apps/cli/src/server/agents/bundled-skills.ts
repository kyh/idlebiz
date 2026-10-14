import { packageFile } from "../../paths";

/**
 * IdleBiz's own skills, laid out as `SessionSetup` says: in the .app or the checkout, which no run
 * writes.
 */
export const bundledSkillsDir = (): string => packageFile("resources/skills");
