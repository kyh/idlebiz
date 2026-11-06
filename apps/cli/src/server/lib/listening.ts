import { once } from "node:events";
import type { Server } from "node:net";
import { report } from "./report";

/**
 * Starts `server` listening as `listen` asks: resolves once it listens, and rejects with the error
 * that stops it. An error after that (an accept that failed) has no caller left to reject, so it
 * is reported as `what`'s.
 */
export const listening = async (
  server: Server,
  what: string,
  listen: () => void,
): Promise<void> => {
  const listened = once(server, "listening");
  listen();
  await listened;
  server.on("error", (error) => {
    report(what, error);
  });
};
