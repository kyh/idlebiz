import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contract } from "@repo/contract/contract";
import { RPC_PREFIX } from "@repo/contract/routes";
import type { ActivityEvent } from "@repo/domain/activity";
import { broadcast, pageEvents } from "./broadcast";
import { listenLoopback } from "./http";

// the page router's `events`, alone, behind the RPC handler main serves the page with
const router = { events: implement(contract).events.handler(({ signal }) => pageEvents(signal)) };

type Client = ContractRouterClient<Pick<typeof contract, "events">>;

let server: Server | null = null;

/** A page's client of a main serving only the event stream, over loopback. */
const serve = async (): Promise<Client> => {
  const handler = new RPCHandler(router);
  const http = createServer((request, response) => {
    void handler.handle(request, response, { context: {}, prefix: RPC_PREFIX });
  });
  server = http;
  const port = await listenLoopback(http);
  return createORPCClient(new RPCLink({ origin: `http://127.0.0.1:${port}`, url: RPC_PREFIX }));
};

afterEach(async () => {
  if (server) {
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
    server = null;
  }
});

const ended = (costUsd: number): ActivityEvent => ({
  createdAt: 1,
  employeeId: "lead",
  id: 7,
  kind: "run.end",
  payload: { costUsd, outcome: { kind: "done" }, settled: "done", summary: "" },
  runId: "r1",
  taskId: "t1",
});

describe("main's events", () => {
  it("reach a page subscribed over the contract, each under its name", async () => {
    const client = await serve();
    const stream = await client.events();
    broadcast("auth", { type: "done" });
    broadcast("activity", ended(0.25));
    const first = await stream.next();
    const second = await stream.next();
    expect(first.value).toEqual({ data: { type: "done" }, name: "auth" });
    expect(second.value).toEqual({ data: ended(0.25), name: "activity" });
    await stream.return();
  });

  it("drop and log an event its schema refuses, and the stream goes on", async () => {
    const client = await serve();
    const stream = await client.events();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // a cost worked out of something missing: JSON would have sent it as null
      broadcast("activity", ended(Number.NaN));
      broadcast("activity", ended(0.5));
      const heard = await stream.next();
      expect(heard.value).toEqual({ data: ended(0.5), name: "activity" });
      expect(logged).toHaveBeenCalledWith("[page event activity]", expect.anything());
    } finally {
      logged.mockRestore();
    }
    await stream.return();
  });
});
