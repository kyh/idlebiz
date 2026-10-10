import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOCKET_PATH_MAX_BYTES, socketDirs } from "./control-plane";
import { claimSave, claimSocketPath } from "./save-claim";

const ALREADY_OPEN = "IdleBiz is already open on this save";

/** A main as the kernel sees it: a process listening on the save's socket, until it is killed. */
const HOLDER = `require("node:net").createServer((c) => c.destroy()).listen(process.argv[1], () => process.stdout.write("held\\n"));`;

describe("the claim a main holds its save by", () => {
  let box = "";
  let root = "";
  let home = "";

  beforeEach(() => {
    // short, so the socket's path under it fits macOS's limit wherever TMPDIR is
    box = mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ib-claim-"));
    root = path.join(box, "save");
    home = path.join(box, "home");
  });

  afterEach(() => {
    rmSync(box, { force: true, recursive: true });
  });

  it("refuses a second main on the same save, saying why, until the first lets it go", async () => {
    const first = await claimSave(root, home);
    await expect(claimSave(root, home)).rejects.toThrow(ALREADY_OPEN);
    first.release();
    expect(existsSync(claimSocketPath(root, home))).toBe(false);
    const next = await claimSave(root, home);
    next.release();
  });

  it("takes the save of a main that was killed, which holds nothing", async () => {
    const socket = claimSocketPath(root, home);
    mkdirSync(root);
    const holder = spawn(process.execPath, ["-e", HOLDER, socket], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await once(holder.stdout, "data");
      await expect(claimSave(root, home)).rejects.toThrow(ALREADY_OPEN);
    } finally {
      holder.kill("SIGKILL");
      await once(holder, "exit");
    }
    // the kernel let go of the listener; its file is left, answering nothing
    expect(existsSync(socket)).toBe(true);
    const next = await claimSave(root, home);
    next.release();
  });

  it("clears a file at the socket's path that is no socket", async () => {
    const socket = claimSocketPath(root, home);
    mkdirSync(root);
    writeFileSync(socket, "");
    const next = await claimSave(root, home);
    next.release();
  });

  it("claims a save whose path is too long for a socket beside the runs' folder in HOME", () => {
    const deep = path.join(box, "s".repeat(SOCKET_PATH_MAX_BYTES));
    expect(claimSocketPath(root, home)).toBe(path.join(root, ".main.sock"));
    expect(claimSocketPath(deep, home)).toBe(`${socketDirs(deep, home).aside}.sock`);
    expect(() => claimSocketPath(deep, path.join(box, "h".repeat(SOCKET_PATH_MAX_BYTES)))).toThrow(
      /could not claim its save/u,
    );
  });
});
