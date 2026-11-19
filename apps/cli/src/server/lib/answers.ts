import { ORPCError } from "@orpc/server";
import { ValidationError } from "@orpc/contract";
import { z } from "zod";
import { errorMessage } from "@repo/domain/errors";
import { RefusalError } from "../refusal";
import { report } from "./report";

const tooLongSchema = z.object({
  code: z.literal("too_big"),
  maximum: z.number(),
  origin: z.literal("string"),
});

const refusedInput = (path: string, error: ValidationError) => {
  const [limit] = error.issues.flatMap((issue) => {
    const tooLong = tooLongSchema.safeParse(issue);

    return tooLong.success ? [tooLong.data.maximum] : [];
  });

  if (limit !== undefined) {
    return new ORPCError<string, unknown>("CONFLICT", {
      message: `Keep it to ${limit} characters or fewer.`,
    });
  }

  const fault = new Error(`[rpc:${path}] input validation failed — ${error.message}`);
  report("rpc", fault);

  return new ORPCError<string, unknown>("BAD_REQUEST", { cause: error, message: fault.message });
};

const isOrpcError = (cause: unknown): cause is ORPCError<string, unknown> =>
  cause instanceof ORPCError;

/** The answer to a call that threw `error`, worded for the founder. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const answerOf = (error: unknown, path: string) => {
  if (error instanceof RefusalError) {
    return new ORPCError<string, unknown>("CONFLICT", { message: error.message });
  }

  if (isOrpcError(error)) {
    return error.cause instanceof ValidationError ? refusedInput(path, error.cause) : error;
  }

  report("rpc", error);

  return new ORPCError<string, unknown>("INTERNAL_SERVER_ERROR", {
    cause: error,
    message: errorMessage(error),
  });
};
