// Safe narrowing for parsed-JSON values: tolerates any input, never throws.
//
// Once the ACP migration removed stdout parsing, `detect.ts` reading the CLI's
// auth output is the only caller left — the rest of the driver gets typed
// params from the protocol.

import { z } from "zod";

const jsonValueSchema = z.json();

/** The full domain of a `JSON.parse` result. */
export type JsonValue = z.infer<typeof jsonValueSchema>;

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonObject = z.infer<typeof jsonObjectSchema>;

export function obj(v: JsonValue | undefined): JsonObject {
  const parsed = jsonObjectSchema.safeParse(v);
  return parsed.success ? parsed.data : {};
}
