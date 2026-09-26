import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import { printfulQuote } from "./printful";
import { priceFloorCents, printFileProblem } from "./print-listing";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CREDENTIAL = { storeId: 42, token: "pf_token" };
const FRONT = {
  fileUrl: "https://acme.vercel.app/print/a.png",
  placement: "front",
  technique: "dtg",
};

interface Asked {
  method: string;
  path: string;
  store: string | null;
  body: JsonValue;
}

const EstimateSchema = z.object({
  order_items: z.tuple([z.object({ catalog_variant_id: z.number() })]),
  recipient: z.object({ state_code: z.string() }),
});

/** The variant and state an estimate was asked for. */
const estimateOf = (body: JsonValue) => {
  const {
    order_items: [item],
    recipient,
  } = EstimateSchema.parse(body);
  return { state: recipient.state_code, variant: item.catalog_variant_id };
};

/** What Printful charges one variant to one state, in dollars as its API writes them. */
type Costs = (variant: number, state: string) => { total: string; shipping: string } | null;

const flatCosts: Costs = (_variant, state) =>
  state === "CA" ? { shipping: "4.75", total: "16.40" } : { shipping: "7.99", total: "18.20" };

/**
 * Printful's catalog and estimates: every task is pending when made and done on its first read,
 * or failed when `costs` has none for it.
 */
const printful = ({
  costs = flatCosts,
  products = { 4012: 71, 4013: 71 },
  currency = "USD",
}: {
  costs?: Costs;
  products?: Record<number, number>;
  currency?: string;
} = {}) => {
  const asked: Asked[] = [];
  const tasks = new Map<string, { variant: number; state: string }>();
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const body = init?.method === "POST" ? parseJson(z.string().parse(init.body)) : null;
    asked.push({
      body,
      method: init?.method ?? "GET",
      path: pathname,
      store: new Headers(init?.headers).get("x-pf-store-id"),
    });
    const variant = /^\/v2\/catalog-variants\/(?<id>\d+)$/u.exec(pathname)?.groups?.id;
    if (variant !== undefined) {
      const product = products[Number(variant)];
      return Promise.resolve(
        product === undefined
          ? Response.json({ code: 404, result: "Not found" }, { status: 404 })
          : Response.json({
              data: {
                catalog_product_id: product,
                color: "Black",
                id: Number(variant),
                name: `Tee (Black / ${variant})`,
                size: variant === "4012" ? "S" : "M",
              },
            }),
      );
    }
    if (init?.method === "POST") {
      const order = estimateOf(body);
      const id = `task-${tasks.size}`;
      tasks.set(id, order);
      return Promise.resolve(
        Response.json({ data: { costs: null, failure_reasons: [], id, status: "pending" } }),
      );
    }
    const id = searchParams.get("id") ?? "";
    const task = tasks.get(id);
    const priced = task ? costs(task.variant, task.state) : null;
    return Promise.resolve(
      Response.json({
        data:
          priced === null
            ? {
                costs: null,
                failure_reasons: ["Placement front: file could not be fetched."],
                id,
                status: "failed",
              }
            : { costs: { currency, ...priced }, failure_reasons: [], id, status: "completed" },
      }),
    );
  });
  return asked;
};

const quote = (variantIds: number[], placements = [FRONT]) =>
  printfulQuote({ credential: CREDENTIAL, placements, variantIds }, { pollMs: 0 });

describe("pricing a print with Printful", () => {
  it("estimates each variant with the design to every sampled US address, keeping the dearest", async () => {
    const asked = printful({
      costs: (variant, state) =>
        variant === 4013 && state === "HI"
          ? { shipping: "9.50", total: "21.10" }
          : flatCosts(variant, state),
    });

    const quoted = await quote([4012, 4013]);

    expect(quoted).toEqual({
      kind: "quoted",
      quote: {
        costCents: 2110,
        shippingCents: 950,
        variants: [
          { id: 4012, label: "Black / S" },
          { id: 4013, label: "Black / M" },
        ],
      },
    });
    const posted = asked.filter((a) => a.method === "POST");
    expect(posted).toHaveLength(6);
    expect(posted[0]).toEqual({
      body: {
        order_items: [
          {
            catalog_variant_id: 4012,
            placements: [
              {
                layers: [{ type: "file", url: FRONT.fileUrl }],
                placement: "front",
                technique: "dtg",
              },
            ],
            quantity: 1,
            source: "catalog",
          },
        ],
        recipient: { country_code: "US", state_code: "CA", zip: "90012" },
      },
      method: "POST",
      path: "/v2/order-estimation-tasks",
      store: "42",
    });
    expect(posted.map((p) => estimateOf(p.body).state)).toEqual([
      "CA",
      "AK",
      "HI",
      "CA",
      "AK",
      "HI",
    ]);
    expect(asked.every((a) => a.store === "42")).toBe(true);
  });

  it("says why Printful could not price it", async () => {
    printful({ costs: (_v, state) => (state === "AK" ? null : flatCosts(4012, state)) });
    expect(await quote([4012])).toEqual({
      kind: "failed",
      reason:
        "Printful could not price variant 4012 to AK: Placement front: file could not be fetched.",
    });
  });

  it("refuses variants of different products, since one design and price cover a listing", async () => {
    const asked = printful({ products: { 4012: 71, 9001: 12 } });
    const quoted = await quote([4012, 9001]);
    expect(quoted).toEqual({
      kind: "failed",
      reason:
        "Those variants are of different Printful products: list each product on its own, since one design and price cover every variant of a listing.",
    });
    expect(asked.filter((a) => a.method === "POST")).toEqual([]);
  });

  it("names a variant the catalog does not have", async () => {
    printful();
    expect(await quote([123])).toEqual({
      kind: "failed",
      reason: "Printful's catalog has no variant 123.",
    });
  });

  it("refuses a store that prices in another currency", async () => {
    printful({ currency: "EUR" });
    expect(await quote([4012])).toEqual({
      kind: "failed",
      reason:
        "Printful prices this store in EUR; IdleBiz sells in USD only. The founder can change the store's currency in Printful.",
    });
  });

  it("tells a token Printful turned away from a failure", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ detail: "expired", status: 401 }, { status: 401 })),
    );
    expect(await quote([4012])).toEqual({ kind: "refused" });
  });

  it("gives Printful's words for any other refusal", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          { code: 400, error: { message: "Invalid technique" }, result: "Bad" },
          { status: 400 },
        ),
      ),
    );
    expect(await quote([4012])).toEqual({
      kind: "failed",
      reason: "Printful answered 400: Invalid technique",
    });
  });
});

describe("the price floor", () => {
  it("covers Printful's dearest cost and Stripe's share, less the shipping the buyer pays", () => {
    // (2110 + 30) / 0.956 = 2238.49…, so 2239 in all, 950 of it shipping
    expect(priceFloorCents({ costCents: 2110, shippingCents: 950, variants: [] })).toBe(1289);
  });
});

/** The product's site answering a print file's URL with `status` and `type`. */
const serving = (status: number, type: string | null) => {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    asked.push({ init, url });
    return Promise.resolve(
      new Response(null, { headers: type === null ? {} : { "content-type": type }, status }),
    );
  });
  return asked;
};

describe("a print file", () => {
  it("is fine when it serves an image, asked without following a redirect", async () => {
    const asked = serving(200, "image/png");
    expect(await printFileProblem(FRONT.fileUrl)).toBeNull();
    expect(asked[0]?.init).toMatchObject({ method: "HEAD", redirect: "manual" });
  });

  it.each([
    { said: "it answers 404", status: 404, type: "text/html" },
    { said: "it answers 308", status: 308, type: null },
    { said: "it serves text/html, not an image", status: 200, type: "text/html" },
  ])("is refused when $said", async ({ said, status, type }) => {
    serving(status, type);
    expect(await printFileProblem(FRONT.fileUrl)).toBe(said);
  });
});
