import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { found } from "../test-support/runs";
import { freshSave } from "../test-support/save";
import * as store from "../store/store";
import { ensureRepository, gitIdentity } from "./run-workspace";

const root = freshSave();

const execFileAsync = promisify(execFile);

describe("gitIdentity", () => {
  it("commits as the employee even where the founder signs every commit and tag with keys the sandbox hides", async () => {
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

  // a template's hooks run as the founder's git does, its config steers it; main's env is
  // launchd's in the app, which any process of the founder's sets for the next launch
  it.each([
    ["GIT_TEMPLATE_DIR", (templates: string) => ({ GIT_TEMPLATE_DIR: templates })],
    [
      "init.templateDir in GIT_CONFIG_*",
      (templates: string) => ({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "init.templateDir",
        GIT_CONFIG_VALUE_0: templates,
      }),
    ],
  ])("makes it from no template that %s in main's env names", async (_, steering) => {
    const box = mkdtempSync(path.join(tmpdir(), "idlebiz-repo-"));
    const templates = path.join(box, "templates");
    const workspace = path.join(box, "workspace");
    mkdirSync(path.join(templates, "hooks"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(path.join(templates, "hooks/pre-commit"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(templates, "config"), "[core]\n\thooksPath = /private/tmp/hooks\n");
    for (const [name, value] of Object.entries(steering(templates))) {
      vi.stubEnv(name, value);
    }
    try {
      await ensureRepository(workspace);
      expect(existsSync(path.join(workspace, ".git/HEAD"))).toBe(true);
      expect(existsSync(path.join(workspace, ".git/hooks/pre-commit"))).toBe(false);
      expect(readFileSync(path.join(workspace, ".git/config"), "utf-8")).not.toContain("hooksPath");
    } finally {
      vi.unstubAllEnvs();
      rmSync(box, { force: true, recursive: true });
    }
  });

  // /usr/bin/git is xcode-select's shim, which runs the git of the developer folder it is pointed at
  it.skipIf(process.platform !== "darwin")(
    "makes it with macOS's git, whatever developer folder main's env names",
    async () => {
      const box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-repo-")));
      const workspace = path.join(box, "workspace");
      const canary = path.join(box, "canary");
      mkdirSync(path.join(box, "developer/usr/bin"), { recursive: true });
      mkdirSync(workspace);
      writeFileSync(
        path.join(box, "developer/usr/bin/git"),
        `#!/bin/sh\n/usr/bin/touch ${canary}\n`,
        { mode: 0o755 },
      );
      vi.stubEnv("DEVELOPER_DIR", path.join(box, "developer"));
      try {
        await ensureRepository(workspace);
        expect(existsSync(path.join(workspace, ".git/HEAD"))).toBe(true);
        expect(existsSync(canary)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        rmSync(box, { force: true, recursive: true });
      }
    },
  );

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
