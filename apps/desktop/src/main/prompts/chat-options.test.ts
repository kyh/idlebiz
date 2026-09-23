import { describe, expect, it } from "vitest";
import { chatOptions } from "./chat-options";
import type { Employee } from "@/shared/domain";

const employee: Employee = {
  companyId: "acme",
  createdAt: 0,
  deskIndex: 0,
  id: "priya",
  lastRunMetrics: null,
  lastShip: null,
  name: "Priya",
  persona: "",
  role: "engineer",
  runner: "claude",
  sessionId: null,
  spriteSeed: "s",
  status: "idle",
  title: "Founding Engineer",
};

describe("a dialogue's options", () => {
  it("offers to build on their last ship, quoting what they said of it", () => {
    const lastShip = { summary: "Added dark mode.", taskId: "dark-mode", title: "Dark mode" };
    const [first] = chatOptions({ ...employee, lastShip }, []);
    expect(first?.label).toBe("Build on: Dark mode");
    expect(first?.instruction).toContain("Added dark mode.");
  });

  it("offers nothing to build on before a first ship", () => {
    const labels = chatOptions(employee, []).map((o) => o.label);
    expect(labels.some((l) => l.startsWith("Build on"))).toBe(false);
  });
});
