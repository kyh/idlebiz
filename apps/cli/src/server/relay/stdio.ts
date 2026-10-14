// Everything but a message that main or a library prints goes to stderr, which the host keeps as
// the log, so no stray write lands inside a message. The host never closes stdin while it runs, so
// a host that quit, crashed or was killed ends main too.

import { createInterface } from "node:readline";
import type { RelayMethod } from "../host";
import { createPeer } from "./rpc";
import type { Peer } from "./rpc";

export const stdioPeer = (onHostGone: () => void): Peer<RelayMethod> => {
  const protocol = process.stdout.write.bind(process.stdout);
  const elsewhere: typeof process.stdout.write = process.stderr.write.bind(process.stderr);
  process.stdout.write = elsewhere;
  const peer = createPeer<RelayMethod>({
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
