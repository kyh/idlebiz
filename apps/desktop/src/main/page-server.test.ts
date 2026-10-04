import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listenLoopback } from "@/main/lib/http";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import { EVENTS_PATH, INVOKE_PATH } from "@/shared/page-routes";
import { devPageOrigin, pagePorts, startPageServer } from "./page-server";
import type { PageServer, PageSource } from "./page-server";

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Asked {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

const ask = (port: number, asked: Asked): Promise<Answer> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  new Promise((resolve, reject) => {
    const req = request(
      {
        headers: { host: `127.0.0.1:${port}`, ...asked.headers },
        host: "127.0.0.1",
        method: asked.method ?? "GET",
        path: asked.path,
        port,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf-8"),
            headers: res.headers,
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(asked.body);
  });

/** The cookie a fresh handoff sets, as the page sends it back. */
const signIn = async (server: PageServer): Promise<string> => {
  const { pathname, search } = new URL(server.handoff().handoffUrl);
  const answer = await ask(server.port, { path: `${pathname}${search}` });
  const [setCookie] = answer.headers["set-cookie"] ?? [];
  const [pair] = setCookie?.split(";") ?? [];
  if (pair === undefined) {
    throw new Error("the handoff set no cookie");
  }
  return pair;
};

const calls: { method: string; payload: JsonValue | undefined }[] = [];

const start = (page: PageSource): Promise<PageServer> =>
  startPageServer({
    dispatch: (method, payload) => {
      calls.push({ method, payload });
      return Promise.resolve({ ok: true, value: method });
    },
    page,
  });

let dir = "";
let servers: PageServer[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "idlebiz-page-"));
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>office</title>");
  await writeFile(path.join(dir, "assets", "office.js"), "export {};");
  await writeFile(path.join(dir, "notes.txt"), "not the page's");
  calls.length = 0;
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  await rm(dir, { force: true, recursive: true });
});

const built = async (): Promise<PageServer> => {
  const server = await start({ dir, kind: "built" });
  servers.push(server);
  return server;
};

describe("main's page server", () => {
  it("answers no host but its own on loopback", async () => {
    const server = await built();
    const rebound = await ask(server.port, {
      headers: { host: `evil.example:${server.port}` },
      path: "/assets/office.js",
    });
    expect(rebound.status).toBe(421);
    const named = await ask(server.port, {
      headers: { host: `localhost:${server.port}` },
      path: "/assets/office.js",
    });
    expect(named.status).toBe(200);
  });

  it("signs a page in once per handoff, and drops the nonce from the address", async () => {
    const server = await built();
    const { handoffUrl, origin } = server.handoff();
    expect(origin).toBe(`http://127.0.0.1:${server.port}`);
    const { pathname, search } = new URL(handoffUrl);
    const first = await ask(server.port, { path: `${pathname}${search}` });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe(`${origin}/`);
    expect(first.headers["set-cookie"]?.[0]).toMatch(/HttpOnly; SameSite=Strict; Path=\//u);
    const again = await ask(server.port, { path: `${pathname}${search}` });
    expect(again.status).toBe(303);
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("shows the office only to a signed-in page, under the page's policy", async () => {
    const server = await built();
    const signedOut = await ask(server.port, { path: "/" });
    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toContain("Open IdleBiz");
    const cookie = await signIn(server);
    const office = await ask(server.port, { headers: { cookie }, path: "/" });
    expect(office.status).toBe(200);
    expect(office.body).toContain("<title>office</title>");
    expect(office.headers["content-security-policy"]).toContain("connect-src 'self';");
    expect(office.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(office.headers["cache-control"]).toBe("no-store");
  });

  it("serves the page's own files, and nothing else of the folder or past it", async () => {
    const server = await built();
    const script = await ask(server.port, { path: "/assets/office.js" });
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.headers["x-content-type-options"]).toBe("nosniff");
    for (const refused of ["/notes.txt", "/assets/missing.js", "/%2e%2e/escape.js", "/%E0%A4%A"]) {
      const answer = await ask(server.port, { path: refused });
      expect(answer.status, refused).toBe(404);
    }
    const posted = await ask(server.port, { method: "POST", path: "/assets/office.js" });
    expect(posted.status).toBe(405);
  });

  it("answers main's calls for the signed-in page, from its own origin alone", async () => {
    const server = await built();
    const call = (headers: Record<string, string>) =>
      ask(server.port, {
        body: JSON.stringify({ method: "getCompany" }),
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
        path: INVOKE_PATH,
      });
    const anonymous = await call({ "sec-fetch-site": "same-origin" });
    expect(anonymous.status).toBe(401);
    expect(parseJson(anonymous.body)).toMatchObject({ ok: false });
    const cookie = await signIn(server);
    // another 127.0.0.1 port carries the cookie: the same site, never the same origin
    const sameSite = await call({ cookie, "sec-fetch-site": "same-site" });
    expect(sameSite.status).toBe(403);
    const otherOrigin = await call({ cookie, origin: "http://127.0.0.1:1" });
    expect(otherOrigin.status).toBe(403);
    expect(calls).toEqual([]);
    const own = await call({ cookie, "sec-fetch-site": "same-origin" });
    expect(own.status).toBe(200);
    expect(parseJson(own.body)).toEqual({ ok: true, value: "getCompany" });
    const byOrigin = await call({ cookie, origin: server.origin });
    expect(byOrigin.status).toBe(200);
    expect(calls).toEqual([
      { method: "getCompany", payload: undefined },
      { method: "getCompany", payload: undefined },
    ]);
  });

  it("refuses a call it cannot read, or past a megabyte", async () => {
    const server = await built();
    const cookie = await signIn(server);
    const headers = { cookie, "sec-fetch-site": "same-origin" };
    for (const body of ["not json", JSON.stringify({ payload: 1 }), "x".repeat(1024 * 1024 + 1)]) {
      const answer = await ask(server.port, { body, headers, method: "POST", path: INVOKE_PATH });
      expect(answer.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("streams main's events to the signed-in page", async () => {
    const server = await built();
    const cookie = await signIn(server);
    // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
    const heard = new Promise<string>((resolve, reject) => {
      const req = request(
        {
          headers: { cookie, host: `127.0.0.1:${server.port}`, "sec-fetch-site": "same-origin" },
          host: "127.0.0.1",
          path: EVENTS_PATH,
          port: server.port,
        },
        (res) => {
          expect(res.headers["content-type"]).toBe("text/event-stream");
          let text = "";
          res.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf-8");
            if (text.includes("data: ")) {
              // the stream stays open until main stops; the frame is all this needs
              resolve(text);
              req.destroy();
            } else {
              server.broadcast("activity:event", { kind: "hello" });
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(await heard).toContain('event: activity:event\ndata: {"kind":"hello"}\n\n');
  });

  it("takes the page's files from a dev server for the signed-in page alone", async () => {
    const vite = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`vite answered ${req.url ?? ""}`);
    });
    const vitePort = await listenLoopback(vite);
    try {
      const server = await start({ kind: "dev", origin: `http://localhost:${vitePort}` });
      servers.push(server);
      const anonymous = await ask(server.port, { path: "/@fs/etc/hosts" });
      expect(anonymous.status).toBe(401);
      const cookie = await signIn(server);
      // `/` on the dev server is `pnpm dev:browser`'s way in, so the document is asked for by name
      const document = await ask(server.port, { headers: { cookie }, path: "/" });
      expect(document.body).toBe("vite answered /index.html");
      const module = await ask(server.port, { headers: { cookie }, path: "/src/main.tsx?t=1" });
      expect(module.body).toBe("vite answered /src/main.tsx?t=1");
    } finally {
      const closed = once(vite, "close");
      vite.close();
      await closed;
    }
  });

  it("names its port for the seal while it answers, and drops it once stopped", async () => {
    const server = await built();
    expect(pagePorts()).toContain(server.port);
    await server.stop();
    expect(pagePorts()).not.toContain(server.port);
  });
});

describe("the page's dev server", () => {
  it("is a loopback http origin, and nothing else", () => {
    expect(devPageOrigin("http://localhost:31100")).toBe("http://localhost:31100");
    expect(devPageOrigin("http://127.0.0.1:31100/")).toBe("http://127.0.0.1:31100");
    for (const refused of [
      "https://localhost:31100",
      "http://example.com:31100",
      "http://me@localhost:31100",
      "file:///tmp/page",
      "not a url",
    ]) {
      expect(() => devPageOrigin(refused), refused).toThrow(/loopback http origin/u);
    }
  });
});
