// Main's end of the channel is its own stdio: the host writes to main's stdin and reads main's
// stdout. Everything else main or a library prints goes to stderr, which the host keeps as the
// log, so no stray write can land inside a message. Stdin's end is the host going away: the host
// never closes it while it runs, so a host that quit, crashed or was killed ends main too.

import { createInterface } from "node:readline";
import { createPeer } from "./rpc";
import type { Peer } from "./rpc";

export const stdioPeer = (onHostGone: () => void): Peer => {
  const protocol = process.stdout.write.bind(process.stdout);
  const elsewhere: typeof process.stdout.write = process.stderr.write.bind(process.stderr);
  process.stdout.write = elsewhere;
  const peer = createPeer({
    failed: (method, reason) => {
      console.error(`[relay] what main does on ${method} failed: ${reason}`);
    },
    stray: (line) => {
      console.error(`[relay] a line from the host that is no message: ${line.slice(0, 200)}`);
    },
    write: (line) => {
      protocol(`${line}\n`);
    },
  });
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: process.stdin });
  lines.on("line", (line) => {
    peer.receive(line);
  });
  lines.on("close", () => {
    peer.close("the host is gone");
    onHostGone();
  });
  return peer;
};
