import { readFile } from "node:fs/promises";
import path from "node:path";
import { RUNNERS } from "@repo/agent-driver/registry";
import { z } from "zod";
import { runEnv } from "@/main/agents/run-env";
import { parseJson } from "@/shared/json";

const UserSettings = z.object({
  apiKeyHelper: z.string().optional(),
  awsAuthRefresh: z.string().optional(),
  awsCredentialExport: z.string().optional(),
  // claude reads a number or a boolean there as its text
  env: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String))
    .default({}),
  gcpAuthRefresh: z.string().optional(),
});

/** What of the founder's claude user settings a run's session is started with. */
export interface ClaudeSignIn {
  /** Their settings' env, as a run gets their shell's: less every name `runEnv` keeps from it. */
  env: Record<string, string>;
  /** The commands claude runs for a key or a cloud login, by their settings' names. */
  helpers: Record<string, string>;
}

/**
 * What in the founder's claude user settings signs their CLI in, which a run's session does not
 * load: a Bedrock, Vertex or gateway setup kept in their settings' env rather than their shell's,
 * and a helper that prints a key or refreshes a cloud login. Nothing when `configDir` holds no
 * settings claude could read either.
 */
export const claudeSignIn = async (configDir: string): Promise<ClaudeSignIn> => {
  let settings: z.infer<typeof UserSettings>;
  try {
    const parsed = UserSettings.safeParse(
      parseJson(await readFile(path.join(configDir, "settings.json"), "utf-8")),
    );
    if (!parsed.success) {
      return { env: {}, helpers: {} };
    }
    settings = parsed.data;
  } catch {
    return { env: {}, helpers: {} };
  }
  const { env, ...named } = settings;
  const helpers = Object.fromEntries(
    Object.entries(named).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { env: runEnv(env, RUNNERS.claude.providerEnv), helpers };
};
