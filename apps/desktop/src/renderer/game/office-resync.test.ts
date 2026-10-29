import { describe, expect, it } from "vitest";
import type { Employee } from "@repo/domain/domain";
import { activityOf, resyncOf } from "./office-resync";
import type { InOffice } from "./office-resync";

const employee = (id: string, status: Employee["status"] = "idle"): Employee => ({
  createdAt: 0,
  deskIndex: 0,
  id,
  instructionsDigest: null,
  lastRunMetrics: null,
  lastShip: null,
  name: id,
  persona: "",
  role: "engineer",
  runner: "claude",
  session: null,
  spriteSeed: id,
  status,
  title: "Engineer",
});

const settled = (id: string, activity: InOffice["activity"] = "idle"): InOffice => ({
  activity,
  id,
  phase: "settled",
});

const nobody: ReadonlySet<string> = new Set();

describe("resyncOf", () => {
  it("walks in who main has and the office lacks, and out who main released", () => {
    const { arrive, leave, set } = resyncOf(
      [settled("lead"), settled("bob")],
      [employee("lead"), employee("mae")],
      nobody,
    );
    expect(arrive).toEqual([employee("mae")]);
    expect(leave).toEqual(["bob"]);
    expect(set).toEqual([]);
  });

  it("lets someone already on their way out go", () => {
    const leaving: InOffice = { activity: "idle", id: "bob", phase: "leaving" };
    expect(resyncOf([leaving], [], nobody)).toEqual({ arrive: [], leave: [], set: [] });
  });

  it("sets only who does something other than main says", () => {
    const { set } = resyncOf(
      [settled("lead", "idle"), settled("mae", "working"), settled("kai", "working")],
      [employee("lead", "working"), employee("mae", "idle"), employee("kai", "working")],
      nobody,
    );
    expect(set).toEqual([
      ["lead", "working"],
      ["mae", "idle"],
    ]);
  });

  it("sits someone whose ask waits at their desk, and frees them once none does", () => {
    const office = [settled("lead", "idle"), settled("mae", "blocked")];
    const roster = [employee("lead"), employee("mae")];
    expect(resyncOf(office, roster, new Set(["lead", "mae"])).set).toEqual([["lead", "blocked"]]);
    expect(resyncOf(office, roster, nobody).set).toEqual([["mae", "idle"]]);
  });
});

describe("activityOf", () => {
  it("puts a run of theirs over an ask of theirs, as the run's own events do", () => {
    expect(activityOf("working", true)).toBe("working");
    expect(activityOf("idle", true)).toBe("blocked");
    expect(activityOf("idle", false)).toBe("idle");
  });
});
