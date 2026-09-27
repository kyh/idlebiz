import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PaymentLinker } from "./payment-links";
import type { RunContext } from "./tools";

// A file of its own: once a reset begins, this process makes no payment link again.
const root = mkdtempSync(path.join(tmpdir(), "idlebiz-reset-during-sale-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("./store/store");
const { askBox } = await import("./agents/agent-driver");
const { callTool } = await import("./tools");
const { switchOffBeforeReset } = await import("./company-actions");

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

const unasked = (what: string) => () => Promise.reject(new Error(`${what} without a test asking`));

describe("a reset while Stripe makes a signed payment link", () => {
  it("waits for the link, switches it off with the rest, and makes no link after", async () => {
    store.initStore();
    const company = store.foundCompany({
      budget: { mode: "infinite" },
      businessType: "software",
      founderName: "Kai",
      founderSpriteSeed: "seed",
      hires: [
        {
          name: "Priya",
          persona: "ships",
          role: "engineer",
          runner: "claude",
          spriteSeed: "Priya",
          title: "Engineer",
        },
      ],
      mission: "ship",
      name: "Acme",
    });
    const employee = store.getEmployee("priya");
    if (!employee) {
      throw new Error("no priya");
    }
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ STRIPE_SECRET_KEY: "rk_live_founder" }),
    );
    const switchedOff: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      const id = /\/v1\/payment_links\/(?<id>\w+)$/u.exec(new URL(url).pathname)?.groups?.id;
      if (id === undefined) {
        return Promise.reject(new Error(`unexpected call to ${url}`));
      }
      switchedOff.push(id);
      return Promise.resolve(Response.json({ active: false, id }));
    });
    const stripe = Promise.withResolvers<Awaited<ReturnType<PaymentLinker>>>();
    let links = 0;
    const asked: unknown[] = [];
    const ctx: RunContext = {
      asks: askBox((ask) => asked.push(ask)),
      assign: (taskId) => asked.push(taskId),
      checkVercelToken: unasked("checked the Vercel token"),
      checkoutAccess: unasked("read checkouts"),
      company,
      createPaymentLink: () => {
        links += 1;
        return stripe.promise;
      },
      deploy: unasked("deployed"),
      driver: { pickRunner: () => "claude", restingRunner: () => null, signedIn: () => true },
      employee,
      linkAccess: () => Promise.resolve({ kind: "granted" }),
      printListing: {
        catalog: unasked("read the catalog"),
        publish: unasked("listed a print"),
        quote: unasked("priced a print"),
        readFile: unasked("fetched a print file"),
        stripeAccess: unasked("read Stripe's grants"),
      },
      productionHosts: unasked("read domains"),
      run: { betId: null, origin: "founder", productId: "acme", runId: "run", taskId: "task" },
      setEnv: unasked("set a variable"),
    };
    const link = { amountUsd: 9, name: "Pro plan" };
    store.grantApproval("task", 'payment link "Pro plan" at $9.00 on acme');

    const making = callTool(ctx, "POST /v1/payment-link", link);
    await vi.waitFor(() => expect(links).toBe(1));
    const reset = switchOffBeforeReset();
    stripe.resolve({ id: "plink_late", kind: "made", url: "https://buy.stripe.com/late" });
    await making;

    expect(await reset).toBeNull();
    expect(switchedOff).toEqual(["plink_late"]);

    store.grantApproval("task", 'payment link "Pro plan" at $9.00 on acme');
    expect(await callTool(ctx, "POST /v1/payment-link", link)).toContain("resetting");
    expect(links).toBe(1);
    expect(asked).toEqual([]);
  });
});
