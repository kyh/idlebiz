import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPeer } from "./rpc";
import type { Peer } from "./rpc";

// two peers wired back to back, as main and the shell are over a pipe
const pair = () => {
  const strays: string[] = [];
  const peers = new Map<"a" | "b", Peer>();
  const a = createPeer({
    stray: (line) => strays.push(`a:${line}`),
    write: (line) => peers.get("b")?.receive(line),
  });
  const b = createPeer({
    stray: (line) => strays.push(`b:${line}`),
    write: (line) => peers.get("a")?.receive(line),
  });
  peers.set("a", a);
  peers.set("b", b);
  return { a, b, strays };
};

describe("the relay's JSON-RPC peer", () => {
  it("answers a request in either direction, parsed by the method's own schema", async () => {
    const { a, b } = pair();
    b.handle("double", z.object({ n: z.number() }), ({ n }) => n * 2);
    a.handle("greet", z.string(), (name) => `hello ${name}`);
    await expect(a.request("double", { n: 21 }, z.number())).resolves.toBe(42);
    await expect(b.request("greet", "founder", z.string())).resolves.toBe("hello founder");
  });

  it("answers a refusal, never a hang: an unknown method, a bad payload, a handler's throw", async () => {
    const { a, b } = pair();
    b.handle("strict", z.object({ n: z.number() }), () => {
      throw new Error("not today");
    });
    await expect(a.request("missing", null, z.null())).rejects.toThrow(/no method missing/u);
    await expect(a.request("strict", { n: "1" }, z.null())).rejects.toThrow();
    await expect(a.request("strict", { n: 1 }, z.null())).rejects.toThrow("not today");
  });

  it("delivers notifications its listener parses, and hands every other line to stray", () => {
    const { a, b, strays } = pair();
    const heard: boolean[] = [];
    b.on("tray", z.object({ on: z.boolean() }), ({ on }) => heard.push(on));
    a.notify("tray", { on: true });
    a.notify("tray", { on: "yes" });
    a.notify("nobody", null);
    b.receive("not json");
    b.receive(JSON.stringify({ id: 99, jsonrpc: "2.0", result: null }));
    expect(heard).toEqual([true]);
    expect(strays).toHaveLength(4);
  });

  it("fails what is in flight, and what is asked after, once the other end is gone", async () => {
    const strays: string[] = [];
    const lonely = createPeer({ stray: (line) => strays.push(line), write: () => {} });
    const asked = lonely.request("hello", null, z.null());
    lonely.close("the shell is gone");
    await expect(asked).rejects.toThrow("the shell is gone");
    await expect(lonely.request("hello", null, z.null())).rejects.toThrow("the shell is gone");
  });
});
