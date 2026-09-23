import { report } from "@/main/lib/report";
import { errorMessage } from "@/shared/errors";
import type { IpcReply } from "@/shared/ipc-channels";
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
