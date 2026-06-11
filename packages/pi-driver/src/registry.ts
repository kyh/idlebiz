import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";

// ModelRegistry.create reads + parses models.json from disk; cache one per
// AuthStorage so repeated one-shot completions don't re-read it each call.
// Keyed weakly so a discarded AuthStorage (e.g. after reset) is collectable.
const registryCache = new WeakMap<AuthStorage, ModelRegistry>();

export function registryFor(authStorage: AuthStorage): ModelRegistry {
  let registry = registryCache.get(authStorage);
  if (!registry) {
    registry = ModelRegistry.create(authStorage);
    registryCache.set(authStorage, registry);
  }
  return registry;
}
