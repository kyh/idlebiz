import { readFile } from "node:fs/promises";
import path from "node:path";
import { ClaudeUserSettingsSchema, RUNNERS } from "@repo/agent-driver/registry";
import type { ClaudeUserSettings } from "@repo/agent-driver/registry";
import { z } from "zod";
import { runEnv } from "./run-env";
import { parseJson } from "@repo/domain/json";

const UserSettings = ClaudeUserSettingsSchema.extend({
  // claude reads a number or a boolean there as its text
  env: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String))
    .default({}),
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
