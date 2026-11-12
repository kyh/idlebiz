import { describe, expect, it } from "vitest";
import { denialOf } from "./denials";

const event = (eventMessage: string): string =>
  JSON.stringify({ eventMessage, messageType: "Error", senderImagePath: "/Sandbox" });

describe("denialOf", () => {
  it("reads the process, operation and path of a deny the label marks", () => {
    expect(
      denialOf(
        event(
          "Sandbox: node(42352) deny(1) file-write-create /Users/me/.ssh/x\nidlebiz-run:ann/t1",
        ),
        "idlebiz-run:",
      ),
    ).toEqual({
      label: "ann/t1",
      operation: "file-write-create",
      process: "node",
      target: "/Users/me/.ssh/x",
    });
  });

  it("reads a deny that names no path, and a process with spaces in its name", () => {
    expect(
      denialOf(
        event("Sandbox: Google Chrome(7) deny(1) lsopen\nidlebiz-run:ann/t1"),
        "idlebiz-run:",
      ),
    ).toEqual({ label: "ann/t1", operation: "lsopen", process: "Google Chrome", target: "" });
  });

  it.each([
    ["the header log stream prints", 'Filtering the log data using "sender == "Sandbox""'],
    ["another sandbox's deny", event("Sandbox: cat(1) deny(1) file-read-data /x\nother:1")],
    ["an unlabelled deny", event("Sandbox: cat(1) deny(1) file-read-data /x")],
    ["another event", event("Sandbox: something else\nidlebiz-run:a")],
  ])("reads nothing from %s", (_what, line) => {
    expect(denialOf(line, "idlebiz-run:")).toBeNull();
  });
});
