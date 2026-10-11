import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefusalError } from "./refusal";
import type { Sealer } from "./secrets";
import { getSecret, heldKeyIn, heldKeys, setSealer, setSecret } from "./secrets";
import {
  printfulCredential,
  printfulTokenStatus,
  removePrintfulToken,
  savePrintfulToken,
} from "./printful-token";
import { tempSave } from "./test-support/save";

const root = tempSave();

const secretsFile = path.join(root, "secrets.json");
const storeFile = path.join(root, "printful-store.json");
const TOKEN = "pf_founder_token_0000000000abcd";

const reversing: Sealer = {
  open: (sealed) => Buffer.from(sealed.toReversed()).toString("utf-8"),
  seal: (plain) => Buffer.from(Buffer.from(plain, "utf-8").toReversed()),
};

beforeEach(() => {
  rmSync(secretsFile, { force: true });
  rmSync(storeFile, { force: true });
  setSealer(reversing);
});

afterEach(() => {
  setSealer(null);
  vi.unstubAllGlobals();
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
    expect(readFileSync(secretsFile, "utf-8")).not.toContain("Acme Prints");
    expect(JSON.parse(readFileSync(storeFile, "utf-8"))).toEqual({ id: 42, name: "Acme Prints" });
    expect(printfulTokenStatus()).toEqual({ last4: "abcd", state: "set", store: "Acme Prints" });
    expect(printfulCredential()).toEqual({ storeId: 42, token: TOKEN });
  });

  it("holds the bare token from every deploy and reply, and never the store", async () => {
    printful();
    await savePrintfulToken(TOKEN);

    expect(heldKeyIn(`const printful = "${TOKEN}";`)).toBe("PRINTFUL_TOKEN");
    expect(heldKeyIn('{"id":42,"name":"Acme Prints"}')).toBeNull();
    expect(heldKeys().map(({ name }) => name)).toEqual(["PRINTFUL_TOKEN"]);
  });

  describe("when the token can't be kept", () => {
    const refusing: Sealer = {
      ...reversing,
      seal: () => {
        throw new Error("the Keychain refused");
      },
    };

    it("keeps no store without a token", async () => {
      printful();
      setSealer(refusing);

      await expect(savePrintfulToken(TOKEN)).rejects.toThrow("the Keychain refused");

      expect(existsSync(storeFile)).toBe(false);
      expect(getSecret("PRINTFUL_TOKEN")).toBeNull();
      expect(printfulTokenStatus()).toEqual({ state: "unset" });
    });

    it("keeps the token saved before with its own store", async () => {
      printful();
      await savePrintfulToken(TOKEN);
      printful({ stores: { data: [{ id: 7, name: "Other Prints", type: "native" }] } });
      setSealer(refusing);

      await expect(savePrintfulToken("pf_other_token_00000000000wxyz")).rejects.toThrow(
        "the Keychain refused",
      );

      expect(printfulCredential()).toEqual({ storeId: 42, token: TOKEN });
      expect(printfulTokenStatus()).toEqual({ last4: "abcd", state: "set", store: "Acme Prints" });
    });
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
    expect(existsSync(storeFile)).toBe(false);
    expect(getSecret("STRIPE_SECRET_KEY")).toBe("sk_live_founder");
  });

  it("counts a token without its store as none", () => {
    setSecret("PRINTFUL_TOKEN", TOKEN);
    expect(printfulTokenStatus()).toEqual({ state: "unset" });
    expect(printfulCredential()).toBeNull();
  });

  it("counts a store without its token as none", () => {
    writeFileSync(storeFile, JSON.stringify({ id: 42, name: "Acme Prints" }));
    expect(printfulTokenStatus()).toEqual({ state: "unset" });
    expect(printfulCredential()).toBeNull();
  });
});
