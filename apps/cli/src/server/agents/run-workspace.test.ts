import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

const { found, root } = await import("./fixtures");
const store = await import("../store/store");
const { ensureRepository, gitIdentity } = await import("./run-workspace");

const execFileAsync = promisify(execFile);

describe("gitIdentity", () => {
  it("commits as the employee even where the founder signs every commit and tag with keys the seal hides", async () => {
    const company = found();
    const mae = store.listEmployees().find((emp) => emp.name === "Mae");
    if (mae === undefined) {
      throw new Error("no hire founded");
    }
    const workspace = mkdtempSync(path.join(tmpdir(), "idlebiz-sign-"));
    const config = path.join(workspace, "founder.gitconfig");
    writeFileSync(
      config,
      "[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n\tforceSignAnnotated = true\n[gpg]\n\tprogram = /usr/bin/false\n",
    );
    const env = {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: workspace,
      PATH: "/usr/bin:/bin",
      ...gitIdentity(mae, company),
    };
    const git = (...args: string[]) => execFileAsync("/usr/bin/git", args, { cwd: workspace, env });
    try {
      await git("init", "--quiet");
      await git("commit", "--allow-empty", "--quiet", "-m", "ship");
      await git("tag", "-a", "v1", "-m", "v1");
      const { stdout } = await git("log", "-1", "--format=%an <%ae>");
      expect(stdout.trim()).toBe(`Mae <${mae.id}@${company.id}.idlebiz.invalid>`);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});

describe("ensureRepository", () => {
  it("makes a workspace a repository once, and leaves one that is", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "idlebiz-repo-"));
    try {
      await ensureRepository(workspace);
      expect(existsSync(path.join(workspace, ".git/HEAD"))).toBe(true);
      writeFileSync(path.join(workspace, ".git/HEAD"), "ref: refs/heads/kept\n");
      await ensureRepository(workspace);
      expect(readFileSync(path.join(workspace, ".git/HEAD"), "utf-8")).toBe(
        "ref: refs/heads/kept\n",
      );
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("goes on without one where git cannot make it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(ensureRepository(path.join(root, "no-such-workspace"))).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith("[repository]", expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });
});
