import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlane, SOCKET_PATH_MAX_BYTES, runSocketPath, socketDirs } from "./control-plane";

// short, so a socket's path under it fits macOS's limit wherever TMPDIR is
const box = mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ib-cp-"));
const root = path.join(box, "save");
const home = path.join(box, "home");
const controlPlane = new ControlPlane(root, home);

beforeAll(() => controlPlane.start());
afterAll(() => {
  controlPlane.stop();
  rmSync(box, { force: true, recursive: true });
});

/** A file's permission bits, as `ls` would spell them in octal. */
const permissions = (file: string): string => statSync(file).mode.toString(8).slice(-3);

interface Answer {
  status: number | undefined;
  body: string;
}

const call = (
  socket: string,
  route: string,
  token: string,
  body: string | null,
  beforeBody: () => void = () => {
    /* empty */
  },
): Promise<Answer> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    if (body !== null) {
      headers.expect = "100-continue";
    }
    const req = request(
      {
        headers,
        host: "idlebiz",
        method: body === null ? "GET" : "POST",
        path: route,
        socketPath: socket,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({ body: Buffer.concat(chunks).toString("utf-8"), status: res.statusCode }),
        );
      },
    );
    req.on("error", reject);
    if (body === null) {
      req.end();
      return;
    }
    req.on("continue", () => {
      // Node dispatches the request handler before the client receives 100 Continue.
      // Authentication has run, and the handler is waiting for this body.
      beforeBody();
      req.end(body);
    });
    req.flushHeaders();
  });

describe("run-scoped control-plane requests", () => {
  it.each([false, true])(
    "checks the run token after reading the body (released: %s)",
    async (released) => {
      const calls: string[] = [];
      const handle = await controlPlane.registerRun((route, raw) => {
        calls.push(`${route} ${JSON.stringify(raw)}`);
        return Promise.resolve("created");
      });
      try {
        const { status } = await call(
          handle.socket,
          "/v1/create-product",
          handle.env.IDLEBIZ_RUN_TOKEN,
          JSON.stringify({ description: "Ships widgets", name: "Widget" }),
          () => {
            if (released) {
              handle.release();
            }
          },
        );
        expect(status).toBe(released ? 401 : 200);
        expect(calls).toEqual(
          released
            ? []
            : ['POST /v1/create-product {"description":"Ships widgets","name":"Widget"}'],
        );
      } finally {
        handle.release();
      }
    },
  );

  it("serves an answer a tool gives only once its work is done", async () => {
    const { promise: called, resolve: arrive } = Promise.withResolvers<string>();
    const { promise: deployed, resolve: finish } = Promise.withResolvers<string>();
    const handle = await controlPlane.registerRun((route) => {
      arrive(route);
      return deployed;
    });
    try {
      const answer = call(handle.socket, "/v1/deploy", handle.env.IDLEBIZ_RUN_TOKEN, "{}");
      expect(await called).toBe("POST /v1/deploy");
      finish("Deployed Acme to production: https://acme.vercel.app");
      const res = await answer;
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        message: "Deployed Acme to production: https://acme.vercel.app",
        ok: true,
      });
    } finally {
      handle.release();
    }
  });

  it("knows a run by the socket it was reached on: another run's token there is refused", async () => {
    const heard: string[] = [];
    const lead = await controlPlane.registerRun((route) => {
      heard.push(`lead ${route}`);
      return Promise.resolve("ok");
    });
    const teammate = await controlPlane.registerRun((route) => {
      heard.push(`teammate ${route}`);
      return Promise.resolve("ok");
    });
    try {
      expect(lead.socket).not.toBe(teammate.socket);
      expect(lead.env.IDLEBIZ_RUN_TOKEN).not.toBe(teammate.env.IDLEBIZ_RUN_TOKEN);
      // a teammate that read the lead's token from its env still reaches only its own socket
      const crossed = await call(teammate.socket, "/v1/open-bet", lead.env.IDLEBIZ_RUN_TOKEN, "{}");
      expect(crossed.status).toBe(401);
      const own = await call(
        teammate.socket,
        "/v1/team-chat",
        teammate.env.IDLEBIZ_RUN_TOKEN,
        null,
      );
      expect(own.status).toBe(200);
      expect(heard).toEqual(["teammate GET /v1/team-chat"]);
    } finally {
      lead.release();
      teammate.release();
    }
  });

  it("makes each socket the founder's alone, in a folder only the founder's user opens, and removes it when the run settles", async () => {
    const handle = await controlPlane.registerRun(() => Promise.resolve(null));
    expect(path.dirname(handle.socket)).toBe(socketDirs(root, home).inSave);
    expect(handle.env.IDLEBIZ_API_SOCKET).toBe(handle.socket);
    expect(statSync(handle.socket).isSocket()).toBe(true);
    expect(permissions(handle.socket)).toBe("600");
    expect(permissions(path.dirname(handle.socket))).toBe("700");
    const missing = await call(handle.socket, "/v1/nothing", handle.env.IDLEBIZ_RUN_TOKEN, null);
    expect(missing.status).toBe(404);
    handle.release();
    expect(existsSync(handle.socket)).toBe(false);
  });

  it("sweeps what a crash left behind at start, and hands a run no socket once stopped", async () => {
    controlPlane.stop();
    await expect(controlPlane.registerRun(() => Promise.resolve(null))).rejects.toThrow(
      "control plane not started",
    );
    const { inSave, aside } = socketDirs(root, home);
    for (const dir of [inSave, aside]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "stale"), "");
    }
    await controlPlane.start();
    expect(existsSync(path.join(inSave, "stale"))).toBe(false);
    expect(existsSync(path.join(aside, "stale"))).toBe(false);
    const handle = await controlPlane.registerRun(() => Promise.resolve(null));
    expect(existsSync(handle.socket)).toBe(true);
    controlPlane.stop();
    expect(existsSync(handle.socket)).toBe(false);
    await controlPlane.start();
  });
});

describe("runSocketPath", () => {
  const id = "0123456789ab";

  it("puts a run's socket in the save, hidden from the company list", () => {
    expect(runSocketPath("/Users/me/.idlebiz", "/Users/me", id)).toBe(
      `/Users/me/.idlebiz/.run/${id}`,
    );
  });

  it("puts it in a folder in HOME named for the save when the save's path is too long", () => {
    const long = `/Users/me/${"deep/".repeat(20)}save`;
    const socket = runSocketPath(long, "/Users/me", id);
    expect(socket).toBe(path.join(socketDirs(long, "/Users/me").aside, id));
    expect(socket.startsWith("/Users/me/.idlebiz-run/")).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);
    // another save gets a folder of its own
    expect(path.dirname(runSocketPath(`${long}2`, "/Users/me", id))).not.toBe(path.dirname(socket));
  });

  it("refuses, naming macOS's limit, when neither fits", () => {
    const long = `/Users/${"x".repeat(100)}`;
    expect(() => runSocketPath(`${long}/.idlebiz`, long, id)).toThrow(
      `longer than the ${SOCKET_PATH_MAX_BYTES} bytes macOS allows`,
    );
  });

  it("counts bytes, not characters", () => {
    // 2 bytes each: fits by characters, not by bytes
    const save = `/${"é".repeat(45)}`;
    expect(save.length + "/.run/".length + id.length).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);
    expect(runSocketPath(save, "/Users/me", id).startsWith("/Users/me/.idlebiz-run/")).toBe(true);
  });
});
