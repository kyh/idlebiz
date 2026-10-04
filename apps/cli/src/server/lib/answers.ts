// How a call the page made is answered when it does not return: the sentence a refusal was worded
// in, as the founder reads it, beside the call that failed. A refusal is just the answer; anything
// else thrown is a fault, answered the same way and kept in main's log. The page router runs every
// call through it (page-router.ts), its input's validation included.

import { ORPCError } from "@orpc/server";
import { ValidationError } from "@orpc/contract";
import { z } from "zod";
import { errorMessage } from "@repo/domain/errors";
import { RefusalError } from "../refusal";
import { report } from "./report";

/** The issue zod reports for text over its limit, which the founder's paste can be. */
const tooLongSchema = z.object({
  code: z.literal("too_big"),
  maximum: z.number(),
  origin: z.literal("string"),
});

/**
 * An input its schema refused. Text over its limit is the founder's to shorten, since no field
 * stops a paste at it; anything else is the page's fault, answered and reported.
 */
const refusedInput = (path: string, error: ValidationError): ORPCError<string, unknown> => {
  const [limit] = error.issues.flatMap((issue) => {
    const tooLong = tooLongSchema.safeParse(issue);
    return tooLong.success ? [tooLong.data.maximum] : [];
  });
  if (limit !== undefined) {
    return new ORPCError("CONFLICT", { message: `Keep it to ${limit} characters or fewer.` });
  }
  const fault = new Error(`[rpc:${path}] input validation failed — ${error.message}`);
  report("rpc", fault);
  return new ORPCError("BAD_REQUEST", { cause: error, message: fault.message });
};

const isOrpcError = (cause: unknown): cause is ORPCError<string, unknown> =>
  cause instanceof ORPCError;

/** The answer to a call that threw `error`, worded for the founder. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const answerOf = (error: unknown, path: string): ORPCError<string, unknown> => {
  if (error instanceof RefusalError) {
    return new ORPCError("CONFLICT", { message: error.message });
  }
  if (isOrpcError(error)) {
    return error.cause instanceof ValidationError ? refusedInput(path, error.cause) : error;
  }
  report("rpc", error);
  return new ORPCError("INTERNAL_SERVER_ERROR", { cause: error, message: errorMessage(error) });
};
