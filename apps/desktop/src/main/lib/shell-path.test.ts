import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptShellPath } from "./shell-path";

// The founder's login shell is zsh under a stand-in home, whose startup puts folders on PATH,
// one not made yet.
describe.skipIf(process.platform !== "darwin")("adoptShellPath", () => {
  const touched = ["HOME", "PATH", "SHELL", "ZDOTDIR"];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  let box = "";
  let home = "";

  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-shell-")));
    home = path.join(box, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(home, "bin"));
    mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    writeFileSync(path.join(home, ".zprofile"), 'export PATH="$HOME/.bun/bin:$HOME/bin:$PATH"\n');
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    delete process.env.ZDOTDIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(box, { force: true, recursive: true });
  });

  it("takes the login shell's PATH, folders not made yet included", async () => {
    await adoptShellPath();

    const adopted = process.env.PATH?.split(path.delimiter) ?? [];
    expect(adopted.slice(0, 2)).toEqual([path.join(home, ".bun/bin"), path.join(home, "bin")]);
    expect(adopted).toContain(path.join(home, ".local/bin"));
    expect(adopted).not.toContain(path.join(home, ".cargo/bin"));
  });
});
