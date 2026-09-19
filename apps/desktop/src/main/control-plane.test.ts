import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlPlane } from "./control-plane";
import type { RunToolHooks } from "./control-plane";

beforeAll(() => controlPlane.start());
afterAll(() => controlPlane.stop());

const unexpected = (): never => {
  throw new Error("unexpected hook");
};

const post = (
  url: string,
  token: string,
  body: string,
  beforeBody: () => void,
): Promise<number | undefined> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          expect: "100-continue",
        },
        method: "POST",
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
        delegate: unexpected,
        hire: unexpected,
        messageTeam: unexpected,
        raiseAsk: unexpected,
        readTeam: unexpected,
        release: unexpected,
      };
      const handle = controlPlane.registerRun(hooks);
      try {
        const status = await post(
          `${controlPlane.baseUrl()}/v1/create-product`,
          handle.env["IDLEBIZ_RUN_TOKEN"] ?? "",
          JSON.stringify({ description: "Ships widgets", name: "Widget" }),
          () => {
            if (released) {
              handle.release();
            }
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
