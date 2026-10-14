import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PaymentLinker } from "./stripe-links";
import type { RunContext } from "./tools/define";
import * as store from "./store/store";
import { askBox } from "./agents/ask-box";
import { callTool } from "./tools";
import { switchOffBeforeReset } from "./reset-links";
import { unaskedIntegrations } from "./test-support/integrations";
import { foundAcme, hire, tempSave } from "./test-support/save";

// A file of its own: once a reset begins, this process makes no payment link again.
const root = tempSave();

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("a reset while Stripe makes a signed payment link", () => {
  it("waits for the link, switches it off with the rest, and makes no link after", async () => {
    store.initStore();
    const company = foundAcme([hire("Priya")]);
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
      ...unaskedIntegrations,
      asks: askBox((ask) => asked.push(ask)),
      assign: (taskId) => asked.push(taskId),
      company,
      createPaymentLink: () => {
        links += 1;
        return stripe.promise;
      },
      employee,
      linkAccess: () => Promise.resolve({ kind: "granted" }),
      run: { betId: null, origin: "founder", productId: "acme", runId: "run", taskId: "task" },
      runners: { pickRunner: () => "claude", restingRunner: () => null, signedIn: () => true },
    };
    const link = { amountUsd: 9, name: "Pro plan" };
    store.grantApproval("task", 'payment link "Pro plan" at $9.00 on acme');

    const making = callTool(ctx, "create_payment_link", link);
    await vi.waitFor(() => expect(links).toBe(1));
    const reset = switchOffBeforeReset();
    stripe.resolve({ id: "plink_late", kind: "made", url: "https://buy.stripe.com/late" });
    await making;

    expect(await reset).toBeNull();
    expect(switchedOff).toEqual(["plink_late"]);

    store.grantApproval("task", 'payment link "Pro plan" at $9.00 on acme');
    const refused = await callTool(ctx, "create_payment_link", link);
    expect(refused?.kind).toBe("refused");
    expect(refused?.text).toContain("resetting");
    expect(links).toBe(1);
    expect(asked).toEqual([]);
  });
});
