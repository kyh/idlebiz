import { z } from "zod";

const answers = z
  .array(
    z.object({ body: z.string(), host: z.string(), route: z.string(), status: z.number().int() }),
  )
  .parse(JSON.parse(process.env.IDLEBIZ_E2E_CANNED ?? "[]"));

const real = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const stub = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);

  if (LOOPBACK.has(url.hostname)) {
    return real(input, init);
  }

  const found = answers.find(
    (answer) => answer.host === url.hostname && answer.route === url.pathname,
  );

  const headers = { "content-type": "application/json" };

  return Promise.resolve(
    found === undefined
      ? new Response("{}", { headers, status: 404 })
      : new Response(found.body, { headers, status: found.status }),
  );
};

Object.defineProperty(globalThis, "fetch", { configurable: true, value: stub, writable: true });
