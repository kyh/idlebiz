import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOCKET_PATH_MAX_BYTES, socketDirs } from "./control-plane";
import { claimDir, claimSave } from "./save-claim";
import type { SaveClaim } from "./save-claim";

const ALREADY_OPEN = "IdleBiz is already open on this save";

/** A main as the kernel sees it: a process listening on its socket in the claim's folder, until it is killed. */
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

  /** Where a main that crashed left its socket: a name of its own in the claim's folder. */
  const crashedFile = (): string => {
    const dir = claimDir(root, home);
    mkdirSync(dir, { recursive: true });
    return path.join(dir, "0123456789abcdef.sock");
  };

  /** Three mains booting on the save at the same moment. */
  const claimTogether = async (): Promise<PromiseSettledResult<SaveClaim>[]> =>
    await Promise.allSettled([1, 2, 3].map(async () => await claimSave(root, home)));

  it("refuses a second main on the same save, saying why, until the first lets it go", async () => {
    const first = await claimSave(root, home);
    await expect(claimSave(root, home)).rejects.toThrow(ALREADY_OPEN);
    first.release();
    expect(readdirSync(claimDir(root, home))).toEqual([]);
    const next = await claimSave(root, home);
    next.release();
  });

  it("takes the save of a main that was killed, which holds nothing", async () => {
    const socket = crashedFile();
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
    expect(existsSync(socket)).toBe(false);
    next.release();
  });

  it("clears a file in the claim's folder that is no socket", async () => {
    const file = crashedFile();
    writeFileSync(file, "");
    const next = await claimSave(root, home);
    expect(existsSync(file)).toBe(false);
    next.release();
  });

  it("keeps a main's claim from another that clears a crash's file after it claimed", async () => {
    const file = crashedFile();
    writeFileSync(file, "");
    const first = await claimSave(root, home);
    // a second main found the file answering nothing before the first claimed, and clears it now
    rmSync(file, { force: true });
    await expect(claimSave(root, home)).rejects.toThrow(ALREADY_OPEN);
    first.release();
  });

  it("lets one of several mains claiming at once hold the save, and never two", async () => {
    let holders = 0;
    for (let round = 0; round < 10; round += 1) {
      writeFileSync(crashedFile(), "");
      const claims = await claimTogether();
      const held = claims.filter((claim) => claim.status === "fulfilled");
      expect(held.length).toBeLessThanOrEqual(1);
      for (const claim of held) {
        claim.value.release();
        holders += 1;
      }
    }
    // each steps back a random while, so all three meeting again on every try is all but impossible
    expect(holders).toBeGreaterThan(0);
  });

  it("claims a save whose path is too long for a socket beside the runs' folder in HOME", () => {
    const deep = path.join(box, "s".repeat(SOCKET_PATH_MAX_BYTES));
    expect(claimDir(root, home)).toBe(path.join(root, ".main"));
    expect(claimDir(deep, home)).toBe(`${socketDirs(deep, home).aside}.main`);
    expect(() => claimDir(deep, path.join(box, "h".repeat(SOCKET_PATH_MAX_BYTES)))).toThrow(
      /could not claim its save/u,
    );
  });
});
