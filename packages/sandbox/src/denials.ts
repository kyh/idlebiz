import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";

/** One thing the sandbox refused a labelled run: which process, the operation and its target. */
export interface Denial {
  label: string;
  process: string;
  operation: string;
  target: string;
}

const LogEvent = z.object({ eventMessage: z.string() });

// The kernel's line, then the deny's message (`Sandbox.label`) on the next.
const DENY =
  /^Sandbox: (?<process>.+)\(\d+\) deny\(\d+\) (?<operation>\S+) ?(?<target>[^\n]*)\n(?<message>.+)$/su;

/** The log event a line holds, or null for the header `log stream` prints first. */
const eventOf = (line: string): z.output<typeof LogEvent> | null => {
  try {
    return LogEvent.safeParse(parseJson(line)).data ?? null;
  } catch {
    return null;
  }
};

/** A Sandbox log event as a denial whose label starts with `prefix`, or null for any other line. */
export const denialOf = (line: string, prefix: string): Denial | null => {
  const event = eventOf(line);
  const groups = event === null ? undefined : DENY.exec(event.eventMessage)?.groups;
  if (groups?.message?.startsWith(prefix) !== true) {
    return null;
  }
  return {
    label: groups.message.slice(prefix.length),
    operation: groups.operation ?? "",
    process: groups.process ?? "",
    target: groups.target ?? "",
  };
};

/**
 * Hands `onDenial` each deny of a sandbox labelled `<prefix><label>`, as the system log records it
 * (`log stream`, which any user may read for their own processes). Stops with the host: the
 * returned function, or the host's exit.
 */
export const watchDenials = (prefix: string, onDenial: (denial: Denial) => void): (() => void) => {
  const stream = spawn(
    "/usr/bin/log",
    [
      "stream",
      "--style",
      "ndjson",
      "--predicate",
      `sender == "Sandbox" AND eventMessage CONTAINS ${JSON.stringify(prefix)}`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const stop = (): void => {
    stream.kill();
  };
  process.once("exit", stop);
  stream.unref();
  // a log that will not start (no `log` off a Mac) reports nothing, and the runs go on
  stream.once("error", stop);
  createInterface({ input: stream.stdout }).on("line", (line) => {
    const denial = denialOf(line, prefix);
    if (denial !== null) {
      onDenial(denial);
    }
  });
  return () => {
    process.off("exit", stop);
    stop();
  };
};
