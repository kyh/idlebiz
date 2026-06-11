import { complete } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { registryFor } from "./registry";

/**
 * One-shot model completion outside any agent session. Resolves credentials
 * for `model` via a ModelRegistry over `authStorage`, runs a single
 * user-message completion, and returns the concatenated text blocks.
 *
 * Throws if no credentials are configured — callers surface that as an error.
 */
export async function completeText(
  authStorage: AuthStorage,
  model: Model<Api>,
  prompt: string,
  system?: string,
): Promise<string> {
  const registry = registryFor(authStorage);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const result = await complete(
    model,
    {
      ...(system === undefined ? {} : { systemPrompt: system }),
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
      ...(auth.headers === undefined ? {} : { headers: auth.headers }),
    },
  );
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
