import { foundAcme, hire } from "./save";

export const SKILLS = "/Applications/IdleBiz.app/Contents/Resources/skills";

/** Acme, founded with Mae alone. */
export const found = () => foundAcme([hire("Mae", "General Manager")]);
