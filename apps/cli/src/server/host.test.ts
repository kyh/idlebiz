import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RELAY_METHODS,
  copyTextSchema,
  handoffSchema,
  keepAwakeSchema,
  launchAtLoginSchema,
  launchSchema,
  loginItemSchema,
  messageBoxSchema,
  noteSchema,
  openingSchema,
  trayClickSchema,
  trayModelSchema,
  windowSchema,
} from "./host";
import type { RelayMethod } from "./host";
import { jsonValueSchema } from "@repo/domain/json";

// the shell's own tests read the same samples into its types (src-tauri/src/protocol.rs)
const SAMPLES = path.resolve(
  import.meta.dirname,
  "../../../desktop/src-tauri/tests/fixtures/relay",
);

const sampleSchema = z.strictObject({
  from: z.enum(["main", "shell"]),
  params: jsonValueSchema,
  // a request's answer; a notification has none
  result: jsonValueSchema.optional(),
});

// how main reads each method: who sends it, its params and, for a request, its answer
interface Message {
  from: "main" | "shell";
  params: z.ZodType;
  result?: z.ZodType;
}

const MESSAGES = {
  handoff: { from: "shell", params: z.null(), result: handoffSchema },
  hello: { from: "shell", params: launchSchema, result: z.null() },
  "host.copyText": { from: "main", params: copyTextSchema, result: z.null() },
  "host.keepAwake": { from: "main", params: keepAwakeSchema },
  "host.loginItem": { from: "main", params: loginItemSchema, result: launchAtLoginSchema },
  "host.messageBox": { from: "main", params: messageBoxSchema, result: z.null() },
  "host.notify": { from: "main", params: noteSchema },
  "host.open": { from: "main", params: openingSchema, result: z.null() },
  "host.relaunch": { from: "main", params: z.null() },
  "host.tray": { from: "main", params: trayModelSchema },
  quit: { from: "shell", params: z.null(), result: z.null() },
  tray: { from: "shell", params: trayClickSchema },
  window: { from: "shell", params: windowSchema },
} satisfies Record<RelayMethod, Message>;

const sampleOf = (method: string) =>
  sampleSchema.parse(JSON.parse(readFileSync(path.join(SAMPLES, `${method}.json`), "utf-8")));

describe("the relay's samples", () => {
  it("are one for every method main names, and none for any other", () => {
    const sampled = readdirSync(SAMPLES)
      .filter((file) => file.endsWith(".json"))
      .map((file) => path.basename(file, ".json"));
    expect(sampled.toSorted()).toEqual([...RELAY_METHODS].toSorted());
  });

  it.each(RELAY_METHODS)("%s reads as main's schema has it", (method) => {
    const message: Message = MESSAGES[method];
    const sample = sampleOf(method);
    expect(sample.from).toBe(message.from);
    expect(message.params.safeParse(sample.params).error).toBeUndefined();
    if (message.result === undefined) {
      expect(sample.result, "a notification is answered with nothing").toBeUndefined();
    } else {
      expect(sample.result, "a request is answered").toBeDefined();
      expect(message.result.safeParse(sample.result).error).toBeUndefined();
    }
  });
});
