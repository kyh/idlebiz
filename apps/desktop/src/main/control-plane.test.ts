import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlPlane, type RunToolHooks } from "./control-plane";

beforeAll(() => controlPlane.start());
afterAll(() => controlPlane.stop());

function unexpected(): never {
  throw new Error("unexpected hook");
}

function post(
  url: string,
  token: string,
  body: string,
  beforeBody: () => void,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          expect: "100-continue",
        },
      },
      (res) => {
        res.resume();
        res.on("error", reject);
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.on("continue", () => {
      // Node dispatches the request handler before the client receives 100 Continue.
      // Authentication has run, and the handler is waiting for this body.
      beforeBody();
      req.end(body);
    });
    req.flushHeaders();
  });
}

describe("run-scoped control-plane requests", () => {
  it.each([false, true])(
    "checks the run token after reading the body (released: %s)",
    async (released) => {
      const products: string[] = [];
      const hooks: RunToolHooks = {
        createProduct: (name, description) => {
          products.push(`${name}: ${description}`);
          return "created";
        },
        messageTeam: unexpected,
        readTeam: unexpected,
        delegate: unexpected,
        hire: unexpected,
        release: unexpected,
        raiseAsk: unexpected,
      };
      const handle = controlPlane.registerRun(hooks);
      try {
        const status = await post(
          `${controlPlane.baseUrl()}/v1/create-product`,
          handle.env["IDLEBIZ_RUN_TOKEN"] ?? "",
          JSON.stringify({ name: "Widget", description: "Ships widgets" }),
          () => {
            if (released) handle.release();
          },
        );
        expect(status).toBe(released ? 401 : 200);
        expect(products).toEqual(released ? [] : ["Widget: Ships widgets"]);
      } finally {
        handle.release();
      }
    },
  );
});
