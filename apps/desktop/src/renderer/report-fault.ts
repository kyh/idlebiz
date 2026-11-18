import { ORPCError } from "@orpc/client";
import { FAULT_LIMITS } from "@repo/contract/app-contract";
import { errorMessage } from "@repo/domain/errors";
import { api } from "@/renderer/api";

const PER_MINUTE = 5;
const MINUTE_MS = 60_000;

let sent: readonly number[] = [];

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const send = async (where: string, message: string, stack: string) => {
  await api.app
    .fault({ message, stack: stack === "" ? undefined : stack, where })
    .catch(() => null);
};

/**
 * Sends a fault the page raised to main's log, named by where it was raised, and waits on nothing.
 * Only its message and stack go, clipped, never what a call was asked: runs read the log, and an
 * input can hold a pasted key. `context` follows the stack, as React's component stack does.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const reportFault = (where: string, fault: unknown, context?: string) => {
  if (fault instanceof ORPCError) {
    return;
  }

  const now = Date.now();
  sent = sent.filter((at) => now - at < MINUTE_MS);

  if (sent.length >= PER_MINUTE) {
    return;
  }

  sent = [...sent, now];

  const stack = [fault instanceof Error ? fault.stack : undefined, context]
    .filter((part) => part !== undefined && part !== "")
    .join("\n");

  void send(
    clip(where, FAULT_LIMITS.where),
    clip(errorMessage(fault), FAULT_LIMITS.message),
    clip(stack, FAULT_LIMITS.stack),
  );
};
