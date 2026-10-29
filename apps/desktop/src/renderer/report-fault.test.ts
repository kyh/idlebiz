import { setImmediate as settle } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORPCError } from "@orpc/client";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { contract } from "@repo/contract/contract";
import { FAULT_LIMITS } from "@repo/contract/app-contract";
import { RPC_PREFIX } from "@repo/contract/routes";

/** A fault as main's log takes it. */
interface Fault {
  where: string;
  message: string;
  stack?: string | undefined;
}

const os = implement(contract);

/** Main's `app.fault` behind the page's fetch, keeping what it was sent, until it goes away. */
const fakeMain = () => {
  const faults: Fault[] = [];
  let down = false;
  const handler = new RPCHandler({
    app: {
      fault: os.app.fault.handler(({ input }) => {
        faults.push(input);
      }),
    },
  });
  const api = async (url: string, init: RequestInit): Promise<Response> => {
    if (down) {
      throw new TypeError("Load failed");
    }
    const { response } = await handler.handle(
      new Request(new URL(url, "http://127.0.0.1:1"), init),
      {
        context: {},
        prefix: RPC_PREFIX,
      },
    );
    return response ?? new Response(null, { status: 404 });
  };
  return {
    api,
    faults,
    goAway: () => {
      down = true;
    },
  };
};

/** The page's reporter, fresh, with `api` behind its fetch. */
const freshReporter = async (api: ReturnType<typeof fakeMain>["api"]) => {
  vi.stubGlobal("fetch", api);
  vi.resetModules();
  const { reportFault } = await import("@/renderer/report-fault");
  return reportFault;
};

describe("reportFault", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends where a fault was raised, its message and its stack, clipped to what main takes", async () => {
    const { api, faults } = fakeMain();
    const reportFault = await freshReporter(api);
    const fault = new Error("x".repeat(FAULT_LIMITS.message + 100));
    fault.stack = "y".repeat(FAULT_LIMITS.stack + 100);
    reportFault("z".repeat(FAULT_LIMITS.where + 10), fault, "in <Hud>");
    await settle();
    const [sent] = faults;
    expect(sent?.where).toHaveLength(FAULT_LIMITS.where);
    expect(sent?.message).toHaveLength(FAULT_LIMITS.message);
    expect(sent?.message.endsWith("…")).toBe(true);
    expect(sent?.stack).toHaveLength(FAULT_LIMITS.stack);
  });

  it("puts what follows the stack after it, and sends no stack when there is none", async () => {
    const { api, faults } = fakeMain();
    const reportFault = await freshReporter(api);
    const fault = new Error("the panel broke");
    fault.stack = "draw@page.js:1:2";
    reportFault("crash-screen", fault, "\n    in Hud");
    reportFault("rejection", "a string thrown");
    await settle();
    expect(faults).toEqual([
      {
        message: "the panel broke",
        stack: "draw@page.js:1:2\n\n    in Hud",
        where: "crash-screen",
      },
      { message: "a string thrown", where: "rejection" },
    ]);
  });

  it("sends a few a minute, so a fault in every frame is not sent every frame", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const { api, faults } = fakeMain();
    const reportFault = await freshReporter(api);
    for (let frame = 0; frame < 60; frame += 1) {
      reportFault("window", new Error(`frame ${frame}`));
    }
    await settle();
    expect(faults.map((f) => f.message)).toEqual([
      "frame 0",
      "frame 1",
      "frame 2",
      "frame 3",
      "frame 4",
    ]);
    vi.setSystemTime(60_000);
    reportFault("window", new Error("a minute on"));
    await settle();
    expect(faults.at(-1)?.message).toBe("a minute on");
  });

  it("sends none of main's answers, which main logged if they were faults", async () => {
    const { api, faults } = fakeMain();
    const reportFault = await freshReporter(api);
    reportFault("office-boot", new ORPCError("INTERNAL_SERVER_ERROR", { message: "no company" }));
    reportFault("rejection", new ORPCError("CONFLICT", { message: "That task is taken." }));
    reportFault("office-boot", new TypeError("Load failed"));
    await settle();
    expect(faults.map(({ message, where }) => ({ message, where }))).toEqual([
      { message: "Load failed", where: "office-boot" },
    ]);
  });

  it("drops a report main cannot take, never leaving it unhandled", async () => {
    const { api, faults, goAway } = fakeMain();
    const reportFault = await freshReporter(api);
    goAway();
    reportFault("office-boot", new Error("main went away"));
    await settle();
    expect(faults).toEqual([]);
  });
});
