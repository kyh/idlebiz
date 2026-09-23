import { errorMessage } from "@/shared/errors";
import type { IpcReply } from "@/shared/ipc-channels";

/** Runs a handler and answers with its value, or with the sentence it refused with. */
export const settle = async <P, R>(
  fn: (payload: P) => R | Promise<R>,
  payload: P,
): Promise<IpcReply<Awaited<R>>> => {
  try {
    return { ok: true, value: await fn(payload) };
  } catch (error) {
    // Electron logs a handler's throw, not a refusal returned as data; keep unexpected ones visible.
    console.error("[ipc]", error);
    return { message: errorMessage(error), ok: false };
  }
};
