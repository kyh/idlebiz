import { getModels } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";

type KnownProvider = Parameters<typeof getModels>[0];

/**
 * Resolve a model from pi-ai's static registry. Throws a descriptive error
 * if the (provider, modelId) pair was not found.
 */
export function resolveModel<Provider extends KnownProvider>(
  provider: Provider,
  modelId: string,
): Model<Api> {
  const model = getModels(provider).find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`Model "${String(provider)}/${modelId}" not found in pi-ai model registry`);
  }
  return model;
}

/**
 * Resolve from a runtime provider string (e.g. parsed from "provider/model").
 * getModels types its arg as a provider union; we hold runtime strings —
 * validated by the lookup — so this is the single boundary narrowing.
 */
export function resolveModelLoose(provider: string, modelId: string): Model<Api> {
  return resolveModel(provider as KnownProvider, modelId);
}
