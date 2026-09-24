import { describe, expect, it } from "vitest";
import { BootGate } from "./boot-gate";

const record = (log: string[], entry: string) => (target: string) => {
  log.push(`${target}:${entry}`);
};

describe("BootGate", () => {
  it("holds what lands while booting and runs it in order once open", () => {
    const gate = new BootGate<string>();
    const log: string[] = [];
    gate.boot();
    gate.run(record(log, "run.start"));
    gate.run(record(log, "run.end"));
    expect(log).toEqual([]);
    gate.open("office");
    expect(log).toEqual(["office:run.start", "office:run.end"]);
    gate.run(record(log, "chat"));
    expect(log).toEqual(["office:run.start", "office:run.end", "office:chat"]);
  });

  it("drops what a torn-down boot held, and a late open from it runs nothing", () => {
    const gate = new BootGate<string>();
    const log: string[] = [];
    gate.boot();
    gate.run(record(log, "spawn"));
    gate.shut();
    gate.run(record(log, "despawn"));
    gate.open("stale");
    gate.run(record(log, "status"));
    expect(log).toEqual([]);
  });

  it("stops holding when a failed boot shuts it, and the next boot opens clean", () => {
    const gate = new BootGate<string>();
    const log: string[] = [];
    gate.boot();
    gate.run(record(log, "held"));
    gate.shut();
    gate.run(record(log, "after"));
    gate.boot();
    gate.run(record(log, "new"));
    gate.open("office");
    expect(log).toEqual(["office:new"]);
  });

  it("starts a restart's hold empty, so only its own events reach its office", () => {
    const gate = new BootGate<string>();
    const log: string[] = [];
    gate.boot();
    gate.run(record(log, "old"));
    gate.boot();
    gate.run(record(log, "new"));
    gate.open("office");
    expect(log).toEqual(["office:new"]);
  });

  it("drops everything before the first boot", () => {
    const gate = new BootGate<string>();
    const log: string[] = [];
    gate.run(record(log, "early"));
    gate.boot();
    gate.open("office");
    expect(log).toEqual([]);
  });
});
