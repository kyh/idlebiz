import { api } from "@/renderer/api";
import type { CharacterAssets } from "@repo/domain/domain";

// One request per seed for the whole renderer: the scene, the busts and the
// onboarding all draw from the same promise, and main caches by sheet behind it.
const cache = new Map<string, Promise<CharacterAssets>>();

export const getCharacterAssets = (seed: string): Promise<CharacterAssets> => {
  let pending = cache.get(seed);
  if (!pending) {
    pending = api().characters.compose({ seed });
    cache.set(seed, pending);
  }
  return pending;
};
