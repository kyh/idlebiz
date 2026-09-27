import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import { createHash } from "node:crypto";
import { printfulCatalog, printfulQuote } from "./printful";
import { priceFloorCents, readPrintFile } from "./print-listing";

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
  order_items: z.tuple([
    z.object({ catalog_variant_id: z.number(), retail_price: z.string().optional() }),
  ]),
  recipient: z.object({ state_code: z.string() }),
});

/** The variant, state and retail price an estimate was asked for. */
const estimateOf = (body: JsonValue) => {
  const {
    order_items: [item],
    recipient,
  } = EstimateSchema.parse(body);
  return {
    retail: item.retail_price ?? null,
    state: recipient.state_code,
    variant: item.catalog_variant_id,
  };
};

/** What Printful charges one variant to one state at a retail price, in dollars as its API writes them. */
type Costs = (
  variant: number,
  state: string,
  retail: string | null,
) => { total: string; shipping: string } | null;

const flatCosts = (_variant: number, state: string): ReturnType<Costs> =>
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
  const tasks = new Map<string, ReturnType<typeof estimateOf>>();
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
    const priced = task ? costs(task.variant, task.state, task.retail) : null;
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

const quote = (variantIds: number[], placements = [FRONT], retailCents = 2800) =>
  printfulQuote(
    { credential: CREDENTIAL, placements, retailCents, variantIds },
    { backoffMs: 0, pollMs: 0 },
  );

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
    expect(posted).toHaveLength(10);
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
            retail_price: "28.00",
            source: "catalog",
          },
        ],
        recipient: { country_code: "US", state_code: "CA", zip: "90012" },
        retail_costs: { currency: "USD" },
      },
      method: "POST",
      path: "/v2/order-estimation-tasks",
      store: "42",
    });
    expect(posted.map((p) => estimateOf(p.body).state)).toEqual([
      "CA",
      "WA",
      "CO",
      "AK",
      "HI",
      "CA",
      "WA",
      "CO",
      "AK",
      "HI",
    ]);
    expect(asked.every((a) => a.store === "42")).toBe(true);
  });

  it("prices California's tax on the listing's own price, as Printful taxes its orders", async () => {
    // Printful taxes a California order on its retail price, or on its own $20.00 plus 10%
    // without one: 9.5% of $22.00 would quote $27.09, a floor of $23.66 that CA orders outcost
    printful({
      costs: (_variant, state, retail) => {
        const tax = state === "CA" ? Math.round(Number(retail ?? "22.00") * 9.5) / 100 : 0;
        return { shipping: "5.00", total: (25 + tax).toFixed(2) };
      },
    });

    const quoted = await quote([4012], [FRONT], 2366);

    expect(quoted).toMatchObject({
      kind: "quoted",
      quote: { costCents: 2725, shippingCents: 500 },
    });
    expect(quoted.kind === "quoted" ? priceFloorCents(quoted.quote) : null).toBe(2382);
  });

  it("prices Seattle's tax and Colorado's delivery fee, which outcost California's tax", async () => {
    // $25.00 shipped, plus each place's tax on the $28.00 listing and Colorado's 29¢ fee
    const rates = new Map([
      ["CA", 9.75],
      ["WA", 10.35],
      ["CO", 8.81],
    ]);
    printful({
      costs: (_variant, state) => {
        const tax = Math.round(28 * (rates.get(state) ?? 0));
        const fee = state === "CO" ? 29 : 0;
        return { shipping: "5.00", total: ((2500 + tax + fee) / 100).toFixed(2) };
      },
    });

    expect(await quote([4012])).toMatchObject({ kind: "quoted", quote: { costCents: 2790 } });
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

describe("Printful's rate limit", () => {
  it("is waited out, and the call tried again", async () => {
    const asked = printful();
    const answer = globalThis.fetch;
    let limited = 2;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (limited > 0) {
        limited -= 1;
        return Promise.resolve(Response.json({ detail: "Too Many Requests" }, { status: 429 }));
      }
      return answer(url, init);
    });

    expect(await quote([4012])).toMatchObject({ kind: "quoted", quote: { costCents: 1820 } });
    expect(asked.filter((a) => a.method === "POST")).toHaveLength(5);
  });

  it("ends the call once it outlasts every retry", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;
      return Promise.resolve(Response.json({ detail: "Too Many Requests" }, { status: 429 }));
    });
    expect(await quote([4012])).toEqual({
      kind: "failed",
      reason: "Printful answered 429: Too Many Requests",
    });
    expect(calls).toBe(4);
  });
});

describe("an answer IdleBiz cannot read", () => {
  it("is a sentence for the agent and a fault in main's log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ data: { id: "4012" } })));
    expect(await quote([4012])).toEqual({
      kind: "failed",
      reason:
        "Printful answered in a shape IdleBiz does not read, which a change on Printful's side causes; try again later",
    });
    expect(logged).toHaveBeenCalledOnce();
  });
});

const TEE = {
  brand: "Bella + Canvas",
  id: 71,
  model: "3001",
  name: "Unisex Staple T-Shirt",
  placements: [
    { layers: [], placement: "front", technique: "dtg" },
    { layers: [], placement: "embroidery_chest_left", technique: "embroidery" },
  ],
  techniques: [{ display_name: "DTG", is_default: true, key: "dtg" }],
  type: "T-SHIRT",
};

describe("reading Printful's catalog", () => {
  it("lists a page of the products that ship to the US, leaving out the discontinued", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      asked.push(`${url} store=${new Headers(init?.headers).get("x-pf-store-id")}`);
      return Promise.resolve(
        Response.json({
          data: [TEE, { ...TEE, id: 12, is_discontinued: true, name: "Old tee" }],
          paging: { limit: 50, offset: 50, total: 120 },
        }),
      );
    });

    expect(await printfulCatalog({ offset: 50 }, CREDENTIAL)).toMatchObject({
      kind: "products",
      offset: 50,
      products: [{ id: 71, name: "Unisex Staple T-Shirt" }],
      total: 120,
    });
    expect(asked).toEqual([
      "https://api.printful.com/v2/catalog-products?destination_country=US&limit=50&offset=50 store=42",
    ]);
  });

  it("gives a product's placements and every variant, labelled as sell_print offers them", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(
        url.endsWith("/catalog-variants")
          ? Response.json({
              data: [
                { catalog_product_id: 71, color: "Black", id: 4012, name: "Tee", size: "S" },
                { catalog_product_id: 71, color: null, id: 4013, name: "Tee One Size", size: null },
              ],
            })
          : Response.json({ data: TEE }),
      ),
    );

    expect(await printfulCatalog({ product: 71 }, CREDENTIAL)).toMatchObject({
      kind: "product",
      product: {
        placements: [
          { placement: "front", technique: "dtg" },
          { placement: "embroidery_chest_left", technique: "embroidery" },
        ],
      },
      variants: [
        { id: 4012, label: "Black / S" },
        { id: 4013, label: "Tee One Size" },
      ],
    });
  });

  it("names a product the catalog does not have, and tells a token turned away", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ code: 404, result: "Not found" }, { status: 404 })),
    );
    expect(await printfulCatalog({ product: 9 }, CREDENTIAL)).toEqual({
      kind: "failed",
      reason: "Printful's catalog has no product 9.",
    });
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({}, { status: 401 })));
    expect(await printfulCatalog({ offset: 0 }, CREDENTIAL)).toEqual({ kind: "refused" });
  });
});

describe("the price floor", () => {
  it("covers Printful's dearest cost and Stripe's share, less the shipping the buyer pays", () => {
    // (2110 + 30) / 0.956 = 2238.49…, so 2239 in all, 950 of it shipping
    expect(priceFloorCents({ costCents: 2110, shippingCents: 950, variants: [] })).toBe(1289);
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** The product's site answering a print file's URL with `status` and `type`, and the file when it is found. */
const serving = (status: number, type: string | null) => {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    asked.push({ init, url });
    return Promise.resolve(
      new Response(status === 200 ? PNG : null, {
        headers: type === null ? {} : { "content-type": type },
        status,
      }),
    );
  });
  return asked;
};

describe("a print file", () => {
  it("is read whole and hashed when it serves an image, asked without following a redirect", async () => {
    const asked = serving(200, "image/png");
    expect(await readPrintFile(FRONT.fileUrl)).toEqual({
      kind: "image",
      sha256: createHash("sha256").update(PNG).digest("hex"),
    });
    expect(asked[0]?.init).toMatchObject({ redirect: "manual" });
    expect(asked[0]?.init?.method).toBeUndefined();
  });

  it.each([
    { said: "it answers 404", status: 404, type: "text/html" },
    { said: "it answers 308", status: 308, type: null },
    { said: "it serves text/html, not an image", status: 200, type: "text/html" },
  ])("is refused when $said", async ({ said, status, type }) => {
    serving(status, type);
    expect(await readPrintFile(FRONT.fileUrl)).toEqual({ kind: "unfit", reason: said });
  });
});
