import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_IDLE_TIMEOUT_MS } from "@repo/agent-driver/runner";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import { DEPLOY_TIMEOUT_MS } from "@/shared/tool-specs";

const scratch = mkdtempSync(path.join(tmpdir(), "idlebiz-deploy-"));
const workspace = path.join(scratch, "workspace");
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = path.join(scratch, "save");
const { deployToVercel } = await import("./deploy");

const TOKEN = "vercel-token";
const BINDING = { projectId: "prj_1", projectName: "acme", teamId: "team_1" };
const sha1 = (data: string | Buffer) => createHash("sha1").update(data).digest("hex");

const put = (file: string, text: string) => {
  const at = path.join(workspace, file);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, text);
};

const FileRef = z.object({ file: z.string(), mode: z.number(), sha: z.string(), size: z.number() });
const Created = z.object({
  files: z.array(FileRef),
  name: z.string(),
  project: z.string().optional(),
  target: z.string(),
});

/** How a deployment is doing, as Vercel answers the create call and then each poll. */
interface State {
  readyState: string;
  alias?: string[];
  aliasAssigned?: number;
  errorMessage?: string;
}

interface FakeVercel {
  /** How GET /v9/projects/<name> answers: whether a project of that name exists. */
  projectExists?: boolean;
  states?: State[];
  /** Answer the create call with this status and error instead. */
  refuse?: { status: number; error: { code: string; message: string } };
  /** Runs when Vercel first asks for the files it lacks. */
  beforeAskingForFiles?: () => void;
}

const LIVE: State = {
  alias: ["acme.vercel.app", "acme-kai.vercel.app"],
  aliasAssigned: 1_700_000_000_000,
  readyState: "READY",
};

const deploymentIn = (state: State | undefined) => ({
  id: "dpl_1",
  projectId: "prj_new",
  url: "acme-abc123.vercel.app",
  ...state,
});

/** Vercel's API, as far as a deploy goes, and every call it was sent. */
const fakeVercel = ({
  projectExists = false,
  states = [LIVE],
  refuse,
  beforeAskingForFiles,
}: FakeVercel = {}) => {
  const stored = new Map<string, Buffer>();
  const calls: { route: string; query: Record<string, string>; auth: string | null }[] = [];
  const created: z.infer<typeof Created>[] = [];
  let polls = 0;
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const route = `${init.method ?? "GET"} ${url.pathname}`;
    const headers = new Headers(init.headers);
    calls.push({
      auth: headers.get("authorization"),
      query: Object.fromEntries(url.searchParams),
      route,
    });
    if (route.startsWith("GET /v9/projects/")) {
      return Promise.resolve(
        projectExists
          ? Response.json({ id: "prj_founders", name: "acme" })
          : Response.json({ error: { code: "not_found" } }, { status: 404 }),
      );
    }
    if (route === "POST /v2/files") {
      const body = init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
      const digest = headers.get("x-vercel-digest") ?? "";
      if (sha1(body) !== digest) {
        return Promise.resolve(
          Response.json({ error: { code: "invalid_digest" } }, { status: 400 }),
        );
      }
      stored.set(digest, body);
      return Promise.resolve(Response.json({ urls: [] }));
    }
    if (route === "POST /v13/deployments") {
      if (refuse) {
        return Promise.resolve(Response.json({ error: refuse.error }, { status: refuse.status }));
      }
      const asked = Created.parse(parseJson(z.string().parse(init.body)));
      const missing = [...new Set(asked.files.map((f) => f.sha))].filter((sha) => !stored.has(sha));
      if (missing.length > 0) {
        beforeAskingForFiles?.();
        return Promise.resolve(
          Response.json(
            { error: { code: "missing_files", message: "Missing files", missing } },
            { status: 400 },
          ),
        );
      }
      created.push(asked);
      return Promise.resolve(Response.json(deploymentIn(states[0])));
    }
    if (route === "GET /v13/deployments/dpl_1") {
      polls += 1;
      return Promise.resolve(
        Response.json(deploymentIn(states[Math.min(polls, states.length - 1)])),
      );
    }
    return Promise.resolve(Response.json({ error: { code: "unexpected" } }, { status: 500 }));
  });
  return { calls, created, stored };
};

const deployBound = () =>
  deployToVercel({ cwd: workspace, target: { binding: BINDING, kind: "bound" }, token: TOKEN });

beforeEach(() => mkdirSync(workspace, { recursive: true }));

afterEach(() => {
  rmSync(workspace, { force: true, recursive: true });
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

describe("deploying through Vercel's API", () => {
  it("answers well inside the run's idle watchdog, since the agent's call waits on it in silence", () => {
    expect(DEPLOY_TIMEOUT_MS * 2).toBeLessThanOrEqual(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it("uploads what the CLI would, deploys it to production in the bound project, and waits for its domain", async () => {
    put("index.html", "<h1>acme</h1>");
    put("src/app.js", "export {};");
    put(".env", "PUBLIC=1");
    put(".vercelignore", "./drafts\n");
    put("drafts/plan.md", "secret plan");
    put(".env.local", "LOCAL=1");
    put(".vercel/project.json", '{"projectId":"prj_other"}');
    put(".git/config", "[core]");
    put("node_modules/left-pad/index.js", "module.exports = 1;");
    const vercel = fakeVercel({ states: [{ readyState: "BUILDING" }, LIVE] });

    await expect(deployBound()).resolves.toEqual({
      alias: "https://acme.vercel.app",
      kind: "deployed",
      project: BINDING,
      url: "https://acme-abc123.vercel.app",
    });
    const [deployment] = vercel.created;
    expect(deployment?.files.map((f) => f.file)).toEqual([
      ".env",
      ".vercelignore",
      "index.html",
      "src/app.js",
    ]);
    expect(deployment).toMatchObject({ name: "acme", project: "prj_1", target: "production" });
    expect(vercel.stored.get(sha1("<h1>acme</h1>"))?.toString()).toBe("<h1>acme</h1>");
    expect(vercel.calls.map((c) => c.route)).toEqual([
      "POST /v13/deployments",
      "POST /v2/files",
      "POST /v2/files",
      "POST /v2/files",
      "POST /v2/files",
      "POST /v13/deployments",
      "GET /v13/deployments/dpl_1",
    ]);
    for (const { auth, query } of vercel.calls) {
      expect(auth).toBe(`Bearer ${TOKEN}`);
      expect(query.teamId).toBe("team_1");
    }
    expect(vercel.calls[0]?.query.skipAutoDetectionConfirmation).toBe("1");
  });

  it("runs nothing the folder holds: a vercel.ts, at the top or in a root directory, is one more file Vercel builds", async () => {
    const marker = path.join(scratch, "ran");
    const config = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nexport default {};\n`;
    put("vercel.ts", config);
    put("app/vercel.mjs", config);
    put(
      "package.json",
      JSON.stringify({ bin: { vercel: "vercel.ts" }, scripts: { prepare: "node vercel.ts" } }),
    );
    const vercel = fakeVercel();

    await expect(deployBound()).resolves.toMatchObject({ kind: "deployed" });
    expect(vercel.created[0]?.files.map((f) => f.file)).toEqual([
      "app/vercel.mjs",
      "package.json",
      "vercel.ts",
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it("uploads a symlink as the path it holds, never the file it names", async () => {
    const secret = path.join(scratch, "secrets.json");
    writeFileSync(secret, '{"STRIPE_SECRET_KEY":"sk_live_founder"}');
    symlinkSync(secret, path.join(workspace, "leak.json"));
    const vercel = fakeVercel();

    await expect(deployBound()).resolves.toMatchObject({ kind: "deployed" });
    const [link] = vercel.created[0]?.files ?? [];
    expect(link).toMatchObject({
      file: "leak.json",
      mode: lstatSync(path.join(workspace, "leak.json")).mode,
    });
    expect(vercel.stored.get(link?.sha ?? "")?.toString()).toBe(secret);
    for (const body of vercel.stored.values()) {
      expect(body.toString()).not.toContain("sk_live_founder");
    }
  });

  it("skips a pipe instead of waiting on it", async () => {
    put("index.html", "hi");
    execFileSync("/usr/bin/mkfifo", [path.join(workspace, "pipe")]);
    const vercel = fakeVercel();

    await expect(deployBound()).resolves.toMatchObject({ kind: "deployed" });
    expect(vercel.created[0]?.files.map((f) => f.file)).toEqual(["index.html"]);
  });

  it("refuses a file that changed after it was read, rather than ship what was never checked", async () => {
    put("index.html", "v1");
    const vercel = fakeVercel({ beforeAskingForFiles: () => put("index.html", "v2") });

    await expect(deployBound()).resolves.toEqual({
      kind: "failed",
      project: null,
      reason:
        "index.html changed while it was being deployed: let the team finish writing, then deploy again.",
    });
    expect(vercel.stored.size).toBe(0);
    expect(vercel.created).toEqual([]);
  });

  it("puts a product bound to nothing into a new project named for it, and names that project", async () => {
    put("index.html", "hi");
    const vercel = fakeVercel();

    await expect(
      deployToVercel({ cwd: workspace, target: { kind: "new", name: "acme" }, token: TOKEN }),
    ).resolves.toMatchObject({
      kind: "deployed",
      project: { projectId: "prj_new", projectName: "acme", teamId: null },
    });
    expect(vercel.calls[0]?.route).toBe("GET /v9/projects/acme");
    expect(vercel.created[0]).not.toHaveProperty("project");
    expect(vercel.created[0]?.name).toBe("acme");
    expect(vercel.calls.every((c) => c.query.teamId === undefined)).toBe(true);
  });

  it("deploys nothing into a project that already holds the name", async () => {
    put("index.html", "hi");
    const vercel = fakeVercel({ projectExists: true });

    await expect(
      deployToVercel({ cwd: workspace, target: { kind: "new", name: "acme" }, token: TOKEN }),
    ).resolves.toEqual({ kind: "name-taken", name: "acme" });
    expect(vercel.calls.map((c) => c.route)).toEqual(["GET /v9/projects/acme"]);
  });

  it("says why a build failed in Vercel's words, and which project it was in", async () => {
    put("index.html", "hi");
    fakeVercel({
      states: [
        { readyState: "QUEUED" },
        { errorMessage: 'Command "npm run build" exited with 1', readyState: "ERROR" },
      ],
    });

    await expect(
      deployToVercel({ cwd: workspace, target: { kind: "new", name: "acme" }, token: TOKEN }),
    ).resolves.toEqual({
      kind: "failed",
      project: { projectId: "prj_new", projectName: "acme", teamId: null },
      reason:
        "Vercel's build failed: Command \"npm run build\" exited with 1. Run the build in the product's folder to see why, fix it, then deploy again.",
    });
  });

  it("answers a call Vercel turns down with its reason, never the key", async () => {
    put("index.html", "hi");
    fakeVercel({
      refuse: { error: { code: "forbidden", message: "Not authorized" }, status: 403 },
    });

    const result = await deployBound();
    expect(result).toEqual({
      kind: "failed",
      project: null,
      reason: "Vercel turned the deploy down (403): Not authorized",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
