import { readFile } from "node:fs/promises";
import path from "node:path";
import { RUNNERS } from "@repo/agent-driver/registry";
import type { ClaudeUserSettings } from "@repo/agent-driver/registry";
import { z } from "zod";
import { runEnv } from "@/main/agents/run-env";
import { parseJson } from "@/shared/json";

/** A model choice that does not read is left to claude's default, not the run's sign-in with it. */
const ignoredIfBad = <T extends z.ZodType>(schema: T) =>
  z
    .unknown()
    .transform((value) => schema.safeParse(value).data)
    .optional();

const UserSettings = z.object({
  alwaysThinkingEnabled: ignoredIfBad(z.boolean()),
  apiKeyHelper: z.string().optional(),
  awsAuthRefresh: z.string().optional(),
  awsCredentialExport: z.string().optional(),
  effortLevel: ignoredIfBad(z.string()),
  // claude reads a number or a boolean there as its text
  env: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String))
    .default({}),
  gcpAuthRefresh: z.string().optional(),
  model: ignoredIfBad(z.string()),
  modelOverrides: ignoredIfBad(z.record(z.string(), z.string())),
  modelSettings: ignoredIfBad(
    z.record(z.string(), z.object({ effortLevel: z.string().optional() })),
  ),
});

/** What of the founder's claude user settings a run's session is started with. */
export interface FounderClaudeSettings {
  /** Their settings' env, as a run gets their shell's: less every name `runEnv` keeps from it. */
  env: Record<string, string>;
  settings: ClaudeUserSettings;
}

const NONE: FounderClaudeSettings = { env: {}, settings: {} };

/**
 * What in the founder's claude user settings a run's session, which loads none of them, still
 * needs: what signs their CLI in (a Bedrock, Vertex or gateway setup kept in their settings' env
 * rather than their shell's, a helper that prints a key or refreshes a cloud login), and the
 * model and effort they picked. Nothing when `configDir` holds no settings claude could read
 * either.
 */
export const claudeUserSettings = async (configDir: string): Promise<FounderClaudeSettings> => {
  let settings: z.infer<typeof UserSettings>;
  try {
    const parsed = UserSettings.safeParse(
      parseJson(await readFile(path.join(configDir, "settings.json"), "utf-8")),
    );
    if (!parsed.success) {
      return NONE;
    }
    settings = parsed.data;
  } catch {
    return NONE;
  }
  const { env, ...named } = settings;
  return { env: runEnv(env, RUNNERS.claude.providerEnv), settings: named };
};
