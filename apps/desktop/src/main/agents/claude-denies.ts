import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import { RefusalError } from "@/shared/refusal";
import { TOOL_NAMES, curlOf } from "@/shared/tool-specs";

/** macOS's managed settings, which outrank every other tier of claude's. */
const MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";

const Settings = z.object({
  permissions: z.object({ deny: z.array(z.string()).optional() }).optional(),
});

/** The deny rules `file` holds; none when it is missing or claude could not read it either. */
const denyRulesIn = async (file: string): Promise<string[]> => {
  try {
    const parsed = Settings.safeParse(parseJson(await readFile(file, "utf-8")));
    return parsed.success ? (parsed.data.permissions?.deny ?? []) : [];
  } catch {
    return [];
  }
};

const BASH_RULE = /^Bash(?:\((?<pattern>.*)\))?$/su;

const escaped = (text: string): string => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/**
 * Whether claude's deny `rule` stops `command` in its Bash tool: `Bash` alone, a prefix
 * (`Bash(curl:*)`) or a pattern whose `*` stands for anything (`Bash(curl *)`).
 */
export const deniesCommand = (rule: string, command: string): boolean => {
  const named = BASH_RULE.exec(rule.trim());
  if (named === null) {
    return false;
  }
  const pattern = named.groups?.pattern ?? "";
  const glob = pattern.endsWith(":*") ? `${pattern.slice(0, -2)}*` : pattern;
  if (glob === "") {
    return true;
  }
  return new RegExp(`^${glob.split("*").map(escaped).join(".*")}$`, "su").test(command);
};

/**
 * Refuses a claude run that the founder's own claude settings would cut off from the company: a
 * deny rule outranks the ask rules the session adds, so each tool's curl would be refused before
 * IdleBiz is asked, and the turn would still end as done. `configDir` is where the founder's
 * claude keeps its settings, `cwd` the project the run loads its settings from.
 */
export const refuseDeniedTools = async (configDir: string, cwd: string): Promise<void> => {
  const commands = TOOL_NAMES.map(curlOf);
  const files = [
    MANAGED_SETTINGS,
    path.join(configDir, "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];
  for (const file of files) {
    const rules = await denyRulesIn(file);
    const rule = rules.find((denied) => commands.some((command) => deniesCommand(denied, command)));
    if (rule !== undefined) {
      throw new RefusalError(
        `Your Claude Code settings deny ${rule} (${file}), and a claude employee reaches the company's tools only with curl, so it did not start. Remove that rule to let claude employees work.`,
      );
    }
  }
};
