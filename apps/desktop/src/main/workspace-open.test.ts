import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { judgeOpening } from "./workspace-open";

const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), "idlebiz-outside-")));
const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "idlebiz-workspace-")));
const product = realpathSync.native(mkdtempSync(path.join(tmpdir(), "idlebiz-product-")));

mkdirSync(path.join(root, "docs"));
mkdirSync(path.join(root, "Report.app"));
writeFileSync(path.join(root, "run.command"), "#!/bin/sh\n");
writeFileSync(path.join(root, "README.MD"), "# hi\n");
symlinkSync(path.join(root, "run.command"), path.join(root, "notes.md"));
writeFileSync(path.join(root, "a.md"), "# hi\n");
execFileSync("/usr/bin/xattr", [
  "-w",
  "com.apple.LaunchServices.OpenWith",
  "x",
  path.join(root, "a.md"),
]);
writeFileSync(path.join(root, "b.md"), "# hi\n");
execFileSync("/usr/bin/xattr", [
  "-wx",
  "com.apple.FinderInfo",
  `616c69734d414353${"0".repeat(48)}`,
  path.join(root, "b.md"),
]);
mkdirSync(path.join(root, "Bare/Contents"), { recursive: true });
writeFileSync(path.join(root, "Bare/Contents/PkgInfo"), "APPL????");
execFileSync("/usr/bin/xattr", [
  "-wx",
  "com.apple.FinderInfo",
  `00000000000000002000${"0".repeat(44)}`,
  path.join(root, "Bare"),
]);
writeFileSync(path.join(outside, "secret.md"), "# not yours\n");
symlinkSync(path.join(outside, "secret.md"), path.join(root, "out.md"));
writeFileSync(path.join(product, "index.html"), "<p>hi</p>\n");

afterAll(() => {
  for (const dir of [root, product, outside]) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("judgeOpening", () => {
  it.each([
    ["", root],
    ["docs/", path.join(root, "docs")],
    ["README.MD", path.join(root, "README.MD")],
  ])("opens %j", (rel, real) => {
    expect(judgeOpening([root], rel)).toEqual({ kind: "open", path: real });
  });

  it.each([
    ["Report.app/", path.join(root, "Report.app")],
    ["Bare", path.join(root, "Bare")],
    ["run.command", path.join(root, "run.command")],
    ["notes.md", path.join(root, "run.command")],
    ["a.md", path.join(root, "a.md")],
    ["b.md", path.join(root, "b.md")],
  ])("reveals %j at its real path", (rel, real) => {
    expect(judgeOpening([root], rel)).toEqual({ kind: "reveal", path: real });
  });

  it("opens an absolute path inside a root", () => {
    expect(judgeOpening([root, product], product)).toEqual({ kind: "open", path: product });
  });

  it.each([
    "out.md",
    "../x",
    `../${path.basename(outside)}/secret.md`,
    "missing.md",
    path.join(outside, "secret.md"),
  ])("refuses %j", (rel) => {
    expect(judgeOpening([root], rel)).toBeNull();
  });

  it("tries every root and skips one that does not exist", () => {
    expect(judgeOpening([path.join(root, "gone"), root, product], "index.html")).toEqual({
      kind: "open",
      path: path.join(product, "index.html"),
    });
  });
});
