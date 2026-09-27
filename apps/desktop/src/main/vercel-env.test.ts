import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson } from "@/shared/json";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-vercel-env-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { keepEnvValue, unshippableEnvValues, setVercelEnv, teamSetEnv } =
  await import("./vercel-env");
const { setSecret } = await import("./secrets");

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
  replaces: true,
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

/** A create whose answer never arrives, then Vercel's list, its variable last changed `changedMsAgo`. */
const lostAnswer = (changedMsAgo: number) => {
  const reads: Record<string, string>[] = [];
  vi.stubGlobal("fetch", (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (init.method === "POST") {
      return Promise.reject(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
    }
    reads.push({ route: url.pathname, ...Object.fromEntries(url.searchParams) });
    return Promise.resolve(
      Response.json(
        {
          envs: [
            { key: "OTHER", target: ["production"], type: "encrypted", value: "" },
            {
              key: "OPENAI_API_KEY",
              target: ["production", "preview"],
              type: "sensitive",
              updatedAt: Date.now() - changedMsAgo,
              value: "",
            },
          ],
        },
        { headers: { Date: new Date().toUTCString() } },
      ),
    );
  });
  return reads;
};

describe("setting a product's variable on Vercel", () => {
  it("upserts a name the team set, sensitive, for production and preview, in the bound project's team, as the founder", async () => {
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

  it("only creates a name the team never set, so a variable already on the project stays the founder's", async () => {
    const calls = fakeVercel(() =>
      Response.json(
        {
          error: {
            code: "ENV_ALREADY_EXISTS",
            message: "A variable with this name already exists",
          },
        },
        { status: 403 },
      ),
    );

    await expect(setVercelEnv({ ...REQUEST, replaces: false })).resolves.toEqual({
      error: "Vercel turned it down (403): A variable with this name already exists",
      ok: false,
    });
    expect(calls.map((c) => c.query)).toEqual([{ teamId: "team_1" }]);
  });

  it("reads a 201 that failed as a failure, and never retries it as a readable variable", async () => {
    const calls = fakeVercel(() =>
      Response.json(
        { created: [], failed: [{ error: { code: "bad_type", key: "OPENAI_API_KEY" } }] },
        { status: 201 },
      ),
    );

    await expect(setVercelEnv(REQUEST)).resolves.toEqual({
      error: "Vercel turned it down: bad_type",
      ok: false,
    });
    expect(calls.map((c) => c.body.type)).toEqual(["sensitive"]);
  });

  it("answers with Vercel's reason, less any value or token it quotes", async () => {
    fakeVercel(() =>
      Response.json(
        {
          error: {
            code: "bad_request",
            message: `Value ${REQUEST.value} is invalid for a request signed ${TOKEN}`,
          },
        },
        { status: 400 },
      ),
    );

    const result = await setVercelEnv(REQUEST);
    expect(result).toEqual({
      error:
        "Vercel turned it down (400): Value [the value] is invalid for a request signed [the token]",
      ok: false,
    });
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

  describe("when Vercel's answer is lost", () => {
    it("counts the variable set once Vercel lists it as changed since the call", async () => {
      const reads = lostAnswer(0);

      await expect(setVercelEnv({ ...REQUEST, replaces: false })).resolves.toEqual({ ok: true });
      expect(reads).toEqual([{ route: "/v10/projects/prj_1/env", teamId: "team_1" }]);
    });

    it("leaves a variable Vercel last changed before the call the founder's", async () => {
      lostAnswer(3_600_000);

      await expect(setVercelEnv({ ...REQUEST, replaces: false })).resolves.toEqual({
        error: "The operation was aborted due to timeout",
        ok: false,
      });
    });
  });
});

describe("the values a deploy may not ship", () => {
  const acme = { companyId: "co", id: "acme" };

  it("keeps one value a name per project of each company's product, replaced when the name is set again, and lets a deploy ship a public one", () => {
    keepEnvValue(acme, "prj_1", "OPENAI_API_KEY", "sk-proj-old");
    keepEnvValue(acme, "prj_1", "OPENAI_API_KEY", "sk-proj-new");
    keepEnvValue({ companyId: "next-co", id: "acme" }, "prj_2", "RESEND_API_KEY", "re_next_key");
    keepEnvValue(acme, "prj_1", "NEXT_PUBLIC_STRIPE_KEY", "pk_live_acmePublishable");

    expect(teamSetEnv(acme, "prj_1", "NEXT_PUBLIC_STRIPE_KEY")).toBe(true);
    expect(unshippableEnvValues()).toEqual([
      { company: "co", kind: "env", name: "OPENAI_API_KEY", product: "acme", value: "sk-proj-new" },
      {
        company: "next-co",
        kind: "env",
        name: "RESEND_API_KEY",
        product: "acme",
        value: "re_next_key",
      },
    ]);
  });

  it("owns a name only on the project of the company's product that set it", () => {
    keepEnvValue(acme, "prj_1", "STRIPE_WEBHOOK_SECRET", "whsec_acme");

    expect(teamSetEnv(acme, "prj_1", "STRIPE_WEBHOOK_SECRET")).toBe(true);
    expect(teamSetEnv(acme, "prj_live", "STRIPE_WEBHOOK_SECRET")).toBe(false);
    expect(teamSetEnv({ companyId: "next-co", id: "acme" }, "prj_1", "STRIPE_WEBHOOK_SECRET")).toBe(
      false,
    );
    expect(teamSetEnv(acme, "prj_1", "DATABASE_URL")).toBe(false);
  });

  it("still guards a value kept before keys named the project, but owns its name on no project", () => {
    setSecret("ENV/older/acme/DATABASE_URL", "postgres://kept-before");

    expect(unshippableEnvValues()).toContainEqual({
      company: "older",
      kind: "env",
      name: "DATABASE_URL",
      product: "acme",
      value: "postgres://kept-before",
    });
    expect(teamSetEnv({ companyId: "older", id: "acme" }, "prj_1", "DATABASE_URL")).toBe(false);
  });
});
