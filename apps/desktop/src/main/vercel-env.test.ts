import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson } from "@/shared/json";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-vercel-env-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { keepEnvValue, keptEnvValues, setVercelEnv } = await import("./vercel-env");

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

const TOKEN = "vercel-token";
const REQUEST = {
  binding: { projectId: "prj_1", projectName: "acme", teamId: "team_1" },
  name: "OPENAI_API_KEY",
  token: TOKEN,
  value: "sk-proj-acme",
};

const Sent = z.object({
  key: z.string(),
  target: z.array(z.string()),
  type: z.string(),
  value: z.string(),
});

/** Vercel's env endpoint, answering each call with the next of `answers`, and every call it was sent. */
const fakeVercel = (...answers: (() => Response)[]) => {
  const calls: {
    route: string;
    query: Record<string, string>;
    auth: string | null;
    body: z.infer<typeof Sent>;
  }[] = [];
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({
      auth: new Headers(init.headers).get("authorization"),
      body: Sent.parse(parseJson(z.string().parse(init.body))),
      query: Object.fromEntries(url.searchParams),
      route: `${init.method ?? "GET"} ${url.pathname}`,
    });
    const answer = answers[calls.length - 1] ?? answers.at(-1);
    return Promise.resolve(answer?.() ?? Response.json({}, { status: 500 }));
  });
  return calls;
};

const created = () =>
  Response.json({ created: { key: "OPENAI_API_KEY" }, failed: [] }, { status: 201 });

describe("setting a product's variable on Vercel", () => {
  it("upserts it sensitive, for production and preview, in the bound project's team, as the founder", async () => {
    const calls = fakeVercel(created);

    await expect(setVercelEnv(REQUEST)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      {
        auth: `Bearer ${TOKEN}`,
        body: {
          key: "OPENAI_API_KEY",
          target: ["production", "preview"],
          type: "sensitive",
          value: "sk-proj-acme",
        },
        query: { teamId: "team_1", upsert: "true" },
        route: "POST /v10/projects/prj_1/env",
      },
    ]);
  });

  it("names no team for a project in the founder's own account", async () => {
    const calls = fakeVercel(created);

    await setVercelEnv({ ...REQUEST, binding: { ...REQUEST.binding, teamId: null } });
    expect(calls[0]?.query).toEqual({ upsert: "true" });
  });

  it("reads a 201 that failed as a failure, and tries once more as a readable variable", async () => {
    const calls = fakeVercel(
      () =>
        Response.json(
          { created: [], failed: [{ error: { code: "bad_type", key: "OPENAI_API_KEY" } }] },
          { status: 201 },
        ),
      created,
    );

    await expect(setVercelEnv(REQUEST)).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.body.type)).toEqual(["sensitive", "encrypted"]);
  });

  it("answers with Vercel's reason when neither type is taken, never the value or the token", async () => {
    const calls = fakeVercel(() =>
      Response.json(
        { error: { code: "bad_request", message: "The value is too large" } },
        { status: 400 },
      ),
    );

    const result = await setVercelEnv(REQUEST);
    expect(result).toEqual({
      error: "Vercel turned it down (400): The value is too large",
      ok: false,
    });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(REQUEST.value);
  });

  it("tries nothing more once the token or the plan is turned away", async () => {
    const calls = fakeVercel(() =>
      Response.json({ error: { code: "forbidden", message: "Not authorized" } }, { status: 403 }),
    );

    await expect(setVercelEnv(REQUEST)).resolves.toEqual({
      error: "Vercel turned it down (403): Not authorized",
      ok: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("answers an unreachable Vercel as a failure rather than throwing", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));

    await expect(setVercelEnv(REQUEST)).resolves.toEqual({ error: "fetch failed", ok: false });
  });
});

describe("the values a deploy may not ship", () => {
  it("keeps one value a name per product, replaced when the name is set again", () => {
    keepEnvValue("acme", "OPENAI_API_KEY", "sk-proj-old");
    keepEnvValue("acme", "OPENAI_API_KEY", "sk-proj-new");
    keepEnvValue("beta", "RESEND_API_KEY", "re_beta_key");

    expect(keptEnvValues()).toEqual([
      { name: "OPENAI_API_KEY", product: "acme", value: "sk-proj-new" },
      { name: "RESEND_API_KEY", product: "beta", value: "re_beta_key" },
    ]);
  });
});
