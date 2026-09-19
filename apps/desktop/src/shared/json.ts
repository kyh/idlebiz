import { z } from "zod";

export const jsonValueSchema = z.json();

/** The full domain of a `JSON.parse` result. */
export type JsonValue = z.infer<typeof jsonValueSchema>;

export const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

export type JsonRecord = z.infer<typeof jsonRecordSchema>;

/** JSON.parse, typed by what it actually returns instead of `any`. */
export const parseJson = (text: string): JsonValue => JSON.parse(text);
