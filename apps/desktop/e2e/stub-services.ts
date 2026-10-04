// Main's stand-ins for Stripe, Vercel and Printful, loaded before main's own code by an e2e launch
// that asks for them (`--import`, e2e/harness.ts): a call is answered from the canned answers the
// harness hands over in IDLEBIZ_E2E_CANNED, so a key being taken is tested with no real account,
// and anything they lack gets a 404, never the network; only loopback (main's own control plane,
// the local sign-in hops) is reached for real. Main reads the global `fetch` on every request, so
// swapping it reaches them all.

import { z } from "zod";

const answers = z
  .array(z.object({ body: z.string(), host: z.string(), route: z.string() }))
  .parse(JSON.parse(process.env.IDLEBIZ_E2E_CANNED ?? "[]"));
const real = globalThis.fetch;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const stub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
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
      : new Response(found.body, { headers }),
  );
};

Object.defineProperty(globalThis, "fetch", { configurable: true, value: stub, writable: true });
