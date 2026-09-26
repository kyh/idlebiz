import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefusalError } from "@/shared/refusal";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-printful-token-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { getSecret, setSealer, setSecret } = await import("./secrets");
const { printfulTokenStatus, removePrintfulToken, savePrintfulToken } =
  await import("./printful-token");
const { printfulCredential } = await import("./printful");

const secretsFile = path.join(root, "secrets.json");
const TOKEN = "pf_founder_token_0000000000abcd";

beforeEach(() => {
  rmSync(secretsFile, { force: true });
  setSealer({
    open: (sealed) => Buffer.from(sealed.toReversed()).toString("utf-8"),
    seal: (plain) => Buffer.from(Buffer.from(plain, "utf-8").toReversed()),
  });
});

afterEach(() => {
  setSealer(null);
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

const ORDERS = { data: [{ name: "View and manage orders", value: "orders" }] };
const ONE_STORE = { data: [{ id: 42, name: "Acme Prints", type: "native" }] };

/** Printful answering the scope and store reads; keeps what each call asked, with which headers. */
const printful = ({
  scopes = ORDERS,
  stores = ONE_STORE,
  status = 200,
}: {
  scopes?: object;
  stores?: object;
  status?: number;
} = {}) => {
  const asked: { url: string; headers: Headers }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    asked.push({ headers: new Headers(init?.headers), url });
    const body = url.endsWith("/v2/oauth-scopes") ? scopes : stores;
    return Promise.resolve(Response.json(status === 200 ? body : { detail: "no" }, { status }));
  });
  return asked;
};

describe("saving the Printful token", () => {
  it("keeps a token that can place orders in one store, sealed, and shows its last four and store", async () => {
    const asked = printful();

    await savePrintfulToken(TOKEN);

    expect(asked.map(({ url }) => url)).toEqual([
      "https://api.printful.com/v2/oauth-scopes",
      "https://api.printful.com/v2/stores",
    ]);
    expect(asked[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(readFileSync(secretsFile, "utf-8")).not.toContain(TOKEN);
    expect(printfulTokenStatus()).toEqual({ last4: "abcd", state: "set", store: "Acme Prints" });
    expect(printfulCredential()).toEqual({ storeId: 42, token: TOKEN });
  });

  it.each([
    { said: "which happens once one expires", status: 401, why: "a token Printful turns away" },
    { said: "Printful answered 500: no", status: 500, why: "a token Printful couldn't check" },
  ])("refuses $why, keeping the token saved before", async ({ said, status }) => {
    printful();
    await savePrintfulToken(TOKEN);
    printful({ status });

    const saving = savePrintfulToken("pf_mistyped_token_000000000000");

    await expect(saving).rejects.toThrow(RefusalError);
    await expect(saving).rejects.toThrow(said);
    expect(getSecret("PRINTFUL_TOKEN")).toBe(TOKEN);
  });

  it("refuses a token that can only read orders", async () => {
    printful({ scopes: { data: [{ name: "View orders", value: "orders/read" }] } });
    await expect(savePrintfulToken(TOKEN)).rejects.toThrow('"View and manage orders" scope');
    expect(printfulTokenStatus()).toEqual({ state: "unset" });
  });

  it.each([
    { said: "reaches no Printful store", stores: { data: [] } },
    {
      said: "reaches 2 Printful stores",
      stores: {
        data: [
          { id: 1, name: "Etsy", type: "etsy" },
          { id: 2, name: "API", type: "native" },
        ],
      },
    },
    {
      said: "reaches 30 Printful stores",
      stores: { data: [{ id: 1, name: "A", type: "native" }], paging: { total: 30 } },
    },
  ])("refuses a token that $said", async ({ said, stores }) => {
    printful({ stores });
    await expect(savePrintfulToken(TOKEN)).rejects.toThrow(said);
    expect(printfulTokenStatus()).toEqual({ state: "unset" });
  });

  it("refuses a token while Printful is out of reach, saving nothing", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    await expect(savePrintfulToken(TOKEN)).rejects.toThrow(
      "Printful couldn't be reached (fetch failed) — nothing was saved; try again.",
    );
    expect(printfulTokenStatus()).toEqual({ state: "unset" });
  });

  it.each([
    { token: "short", what: "a token cut short" },
    { token: "pf founder token with spaces", what: "a token with spaces" },
    { token: "pf_founder_token​000000000", what: "a token with an invisible character" },
  ])("refuses $what without asking Printful or echoing it", async ({ token }) => {
    const asked = printful();
    const saving = savePrintfulToken(token);
    await expect(saving).rejects.toThrow("That isn't a Printful token");
    await expect(saving).rejects.not.toThrow(token);
    expect(asked).toEqual([]);
  });
});

describe("removing the Printful token", () => {
  it("forgets the token and its store, and leaves the Stripe key", async () => {
    printful();
    await savePrintfulToken(TOKEN);
    setSecret("STRIPE_SECRET_KEY", "sk_live_founder");

    removePrintfulToken();

    expect(printfulTokenStatus()).toEqual({ state: "unset" });
    expect(printfulCredential()).toBeNull();
    expect(getSecret("PRINTFUL_STORE")).toBeNull();
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder");
  });

  it("counts a token without its store as none", () => {
    setSecret("PRINTFUL_TOKEN", TOKEN);
    expect(printfulTokenStatus()).toEqual({ state: "unset" });
    expect(printfulCredential()).toBeNull();
  });
});
