import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import { RefusalError } from "../refusal";
import { TOOL_NAMES, commandOf } from "../tool-specs";

/**
 * Where macOS keeps claude's managed settings files, one of the sources of its managed tier,
 * which outranks every other tier of claude's.
 */
const MANAGED_DIR = "/Library/Application Support/ClaudeCode";

/**
 * The managed settings files in `dir`, in the order claude merges them into one source:
 * `managed-settings.json`, then each drop-in of `managed-settings.d/`, alphabetically, but a
 * hidden one or one not ending in `.json`.
 */
const managedFiles = async (dir: string): Promise<string[]> => {
  const dropIns = path.join(dir, "managed-settings.d");
  let names: string[] = [];
  try {
    names = await readdir(dropIns);
  } catch {
    // none, or none claude could read either
  }
  return [
    path.join(dir, "managed-settings.json"),
    ...names
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .toSorted()
      .map((name) => path.join(dropIns, name)),
  ];
};

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
 * (`Bash(idlebiz:*)`) or a pattern whose `*` stands for anything (`Bash(idlebiz *)`).
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
 * Refuses a claude run that the managed settings files in `dir` would cut off from the company.
 * Managed policy is the one tier of the founder's settings a run's session still loads, and a
 * deny rule there outranks the ask rules the session adds, so each tool's `idlebiz` command would
 * be refused before IdleBiz is asked, and the turn would still end as done. The files are the one
 * source of that tier read here, their deny lists unioned as claude merges them, and read even
 * where a source above them shadows them: the MDM profile, server-managed settings and a
 * `policyHelper` go unread (docs/seal.md's "What stays open").
 */
export const refuseDeniedTools = async (dir: string = MANAGED_DIR): Promise<void> => {
  const commands = TOOL_NAMES.map(commandOf);
  const files = await managedFiles(dir);
  const denied = await Promise.all(
    files.map(async (file) => ({ file, rules: await denyRulesIn(file) })),
  );
  for (const { file, rules } of denied) {
    const rule = rules.find((r) => commands.some((command) => deniesCommand(r, command)));
    if (rule !== undefined) {
      throw new RefusalError(
        `Your Claude Code managed settings deny ${rule} (${file}), and a claude employee reaches the company's tools only with the idlebiz command, so it did not start. Remove that rule to let claude employees work.`,
      );
    }
  }
};
