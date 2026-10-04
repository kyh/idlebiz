// What people look like: a sheet composed from a seed, and the founder's choices.

import { oc, type } from "@orpc/contract";
import type { CharacterAssets } from "@repo/domain/domain";
import { composeCharacterInput } from "./characters-schema";

export const charactersContract = {
  compose: oc.input(composeCharacterInput).output(type<CharacterAssets>()),
  /** Sprite seeds the founder may pick a look from. */
  founders: oc.output(type<string[]>()),
};
