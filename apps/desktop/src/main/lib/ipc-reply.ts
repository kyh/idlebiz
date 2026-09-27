import type { z } from "zod";
import { report } from "@/main/lib/report";
import { errorMessage } from "@/shared/errors";
import type { IpcFailure, IpcReply } from "@/shared/ipc-channels";
import { RefusalError } from "@/shared/refusal";

/** Runs a handler and answers with its value, or with the sentence it refused with. */
export const settle = async <P, R>(
  fn: (payload: P) => R | Promise<R>,
  payload: P,
): Promise<IpcReply<Awaited<R>>> => {
  try {
    return { ok: true, value: await fn(payload) };
  } catch (error) {
    // Electron logs a handler's throw, not one returned as data; a refusal is just the answer.
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
