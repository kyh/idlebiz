import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMainLog, mainLogPath } from "./main-log";

const scratch = () => mkdtempSync(path.join(tmpdir(), "idlebiz-main-log-"));

const read = (file: string) => readFileSync(file, { encoding: "utf-8", flag: "a+" });

describe("main's log", () => {
  it("stamps every line of a message in UTC to the millisecond", () => {
    const file = mainLogPath(path.join(scratch(), "logs"));
    const log = createMainLog(file);
    log.append("first\nsecond");
    log.append("third");
    const lines = read(file).trimEnd().split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z first$/u);
    expect(lines[2]).toMatch(/ third$/u);
  });

  it("rotates into one backup past the cap", () => {
    const dir = path.join(scratch(), "logs");
    const file = mainLogPath(dir);
    const log = createMainLog(file, 80);
    log.append("one");
    log.append("two");
    log.append("three");

    expect(read(`${file}.1`)).toContain(" one");
    expect(read(file)).toContain(" three");
    expect(read(file)).not.toContain(" one");
  });

  it("cuts a line bigger than the cap to it, splitting no character", () => {
    const file = mainLogPath(path.join(scratch(), "logs"));
    const log = createMainLog(file, 80);
    log.append("before");
    log.append("é".repeat(200));
    log.append("after");

    for (const each of [file, `${file}.1`]) {
      expect(statSync(each).size).toBeLessThanOrEqual(80);
    }

    expect(read(`${file}.1`)).toMatch(/é \[cut\]\n$/u);
    expect(read(file)).toContain(" after");
  });

  it("costs a failed write its line alone", () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "logs"), "");
    const log = createMainLog(mainLogPath(path.join(dir, "logs")));
    log.append("lost");
    log.append("lost too");

    expect(log.failing()).toBe(true);
  });
});
