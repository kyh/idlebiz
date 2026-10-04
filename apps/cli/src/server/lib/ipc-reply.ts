import type { z } from "zod";
import { report } from "./report";
import { errorMessage } from "@repo/domain/errors";
import type { IpcFailure, IpcReply } from "@repo/contract/ipc-channels";
import { RefusalError } from "../refusal";

/** Runs a handler and answers with its value, or with the sentence it refused with. */
export const settle = async <P, R>(
  fn: (payload: P) => R | Promise<R>,
  payload: P,
): Promise<IpcReply<Awaited<R>>> => {
  try {
    return { ok: true, value: await fn(payload) };
  } catch (error) {
    // a refusal is just the answer; anything else thrown is a fault, and main's log keeps it
    if (!(error instanceof RefusalError)) {
      report("ipc", error);
    }
    return { message: errorMessage(error), ok: false };
  }
};

/**
 * Answers a payload its schema refused. Text over its limit is the founder's to shorten, since
 * no field stops a paste at it; anything else is the renderer's fault, answered and reported.
 */
export const refusePayload = (method: string, error: z.ZodError): IpcFailure => {
  const [limit] = error.issues.flatMap((issue) =>
    issue.code === "too_big" && issue.origin === "string" ? [issue.maximum] : [],
  );
  if (limit !== undefined) {
    return { message: `Keep it to ${limit} characters or fewer.`, ok: false };
  }
  const fault = new Error(`[ipc:${method}] payload validation failed — ${error.message}`);
  report("ipc", fault);
  return { message: fault.message, ok: false };
};
