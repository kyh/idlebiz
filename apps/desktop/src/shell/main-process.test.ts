import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MainLateError, startMain } from "./main-process";
import type { MainHost } from "./main-process";

const FAKE_MAIN = String.raw`
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let booting = false;
let lingering = false;
console.error("main is up");
process.stdout.write("not a message\n");
readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "echo") send({ id: message.id, result: message.params });
    else if (message.method === "refuse") send({ id: message.id, error: { code: -32000, message: "no" } });
    else if (message.method === "ask") send({ id: 900, method: "host.ping", params: message.params });
    else if (message.method === "die") process.exit(3);
    else if (message.method === "wedge") { process.stdin.pause(); setInterval(() => {}, 1000); send({ method: "wedged" }); }
    else if (message.method === "hello") { booting = true; setInterval(() => {}, 1000); send({ method: "booting" }); }
    else if (message.method === "linger") lingering = true;
    else if (message.method === "quit") {
      const answer = () => send({ id: message.id, result: null });
      if (lingering) setTimeout(answer, 100);
      else if (!booting) answer();
    }
    else if (message.id === 900) send({ method: "pong", params: message.result ?? message.error });
  })
  .on("close", () => { if (!booting) process.exit(0); });
send({ method: "hi", params: { n: 1 } });
`;

type FakeMethod =
  | "ask"
  | "booting"
  | "die"
  | "echo"
  | "hang"
  | "hello"
  | "hi"
  | "host.ping"
  | "linger"
  | "pong"
  | "quit"
  | "refuse"
  | "wedge"
  | "wedged";

const GRACE_MS = 300;
const WAIT_MS = 2000;

const started = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "idlebiz-main-"));
  const entry = path.join(dir, "main.cjs");
  writeFileSync(entry, FAKE_MAIN);
  const logged: string[] = [];
  const heard = new EventTarget();
  const lost = Promise.withResolvers<number | null>();
  let wasLost = false;

  const hearing = async (method: FakeMethod) => {
    const events: unknown[] = await once(heard, method);
    const [event] = events;

    return event instanceof CustomEvent ? z.unknown().parse(event.detail) : null;
  };

  const host = {
    listen: (peer) => {
      peer.handle("host.ping", z.unknown(), (params) => ({ pinged: z.string().parse(params) }));

      for (const method of ["hi", "pong", "wedged", "booting"] as const) {
        peer.on(method, z.unknown(), (params) => {
          heard.dispatchEvent(new CustomEvent(method, { detail: params }));
        });
      }
    },
    lost: (code) => {
      wasLost = true;
      lost.resolve(code);
    },
  } satisfies MainHost<FakeMethod>;

  const hi = hearing("hi");

  const main = startMain<FakeMethod>(
    {
      args: [],
      entry,
      env: { PATH: process.env.PATH ?? "" },
      exitGraceMs: GRACE_MS,
      log: (line) => logged.push(line),
      node: process.execPath,
      note: (line) => logged.push(line),
      quit: "quit",
      quitTimeoutMs: GRACE_MS,
    },
    host,
  );

  return { hearing, hi, logged, lost: lost.promise, main, wasLost: () => wasLost };
};

describe("main as the shell's child", () => {
  it("relays both ways and stops through quit", async () => {
    const { hearing, hi, logged, main, wasLost } = started();

    await expect(hi).resolves.toStrictEqual({ n: 1 });
    await expect(main.request("echo", { a: [1, 2] }, z.unknown(), WAIT_MS)).resolves.toStrictEqual({
      a: [1, 2],
    });
    await expect(main.request("refuse", null, z.unknown(), WAIT_MS)).rejects.toThrow("no");

    const pong = hearing("pong");
    main.notify("ask", "x");

    await expect(pong).resolves.toStrictEqual({ pinged: "x" });

    await main.stop();

    expect(main.exited()).toBe(true);
    expect(wasLost()).toBe(false);
    await expect(main.request("echo", null, z.unknown(), WAIT_MS)).rejects.toThrow(
      "main is not running",
    );
    expect(logged).toContain("main is up");
    expect(logged).toContain("[main] not a message");
    expect(logged).toContain("main exited (code 0)");
  });

  it("stops a main that stopped reading all the same", async () => {
    const { hearing, hi, main } = started();
    await hi;
    const wedged = hearing("wedged");
    main.notify("wedge", null);
    await wedged;

    for (let filler = 0; filler < 64; filler += 1) {
      main.notify("echo", "x".repeat(4096));
    }

    await main.stop();

    expect(main.exited()).toBe(true);
  });

  it("fails what waits on a main that exits unasked, and says it is lost", async () => {
    const { hi, lost, main } = started();
    await hi;
    const hanging = main.request("hang", null, z.unknown(), WAIT_MS * 5);
    main.notify("die", null);

    await expect(lost).resolves.toBe(3);
    await expect(hanging).rejects.toThrow("main is gone");
    await main.stop();
  });

  it("kills a main that never boots at the deadline, which is not lost then", async () => {
    const { hi, logged, main, wasLost } = started();
    await hi;

    await expect(main.boot("hello", null, z.null(), GRACE_MS)).rejects.toBeInstanceOf(
      MainLateError,
    );
    expect(main.exited()).toBe(true);
    expect(wasLost()).toBe(false);
    expect(logged).toContain("[shell] main did not boot within 0.3 seconds; killing it");
  });

  it("ends a main whose boot never ends when a quit comes during it", async () => {
    const { hearing, hi, main } = started();
    await hi;
    const booting = hearing("booting");
    const hello = main.request("hello", null, z.null(), WAIT_MS * 5);
    await booting;

    await main.stop();

    expect(main.exited()).toBe(true);
    await expect(hello).rejects.toThrow("main is gone");
  });

  it("makes a stop asked while another is under way wait for main to exit", async () => {
    const { hi, main } = started();
    await hi;
    await main.request("echo", null, z.unknown(), WAIT_MS);
    main.notify("linger", null);
    const first = main.stop();
    const second = main.stop();

    await second;

    expect(main.exited()).toBe(true);
    await first;
  });
});
