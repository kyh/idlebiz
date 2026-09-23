import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { betNews } from "@/main/prompts/briefs";
import type { Bet } from "@/shared/bets";
import type { Company, Product, ProductDraft, Speaker, Task } from "@/shared/domain";

// A change to the company that everyone should hear about: the store mutation,
// the activity event and the team-room line, together. The scheduler, the
// agents' tools and the founder's IPC all come through here, so a change reads
// the same whoever made it.

/**
 * A line in the team room, the only way one is written, so the room agents read
 * and the founder's #team feed hear the same lines. `to` names the teammate it
 * is handed to, if any.
 */
export const postToRoom = (from: Speaker, text: string, to: string | null = null): void => {
  const line = text.slice(0, 400);
  store.postTeamMessage(from, line);
  publishActivity({
    employeeId: from.kind === "employee" ? from.id : null,
    kind: "chat",
    message: line,
    payload: { from, to },
  });
};

export const announceBet = (bet: Bet): void => {
  publishActivity({
    kind: "bet.changed",
    message: bet.title,
    payload: { betId: bet.id, state: bet.state },
  });
  postToRoom({ kind: "office" }, betNews(bet));
};

/** Give up on a live bet, from the lead's tool or the founder's panel. */
export const killBet = (betId: string, reason: string): Bet => {
  const killed = store.killBet(betId, reason, Date.now());
  announceBet(killed);
  return killed;
};

/** Retire a product and everything riding on it. `by` is the lead who called it; null is the founder. */
export const retireProduct = (productId: string, reason: string, by: string | null): Product => {
  const product = store.requireProduct(productId);
  for (const bet of store.killProduct(productId, reason, by)) {
    announceBet(bet);
  }
  postToRoom(
    by === null ? { kind: "founder" } : { id: by, kind: "employee" },
    `🪦 Retired ${product.name} — ${reason}`,
  );
  publishActivity({
    employeeId: by,
    kind: "product.killed",
    message: product.name,
    payload: { productId, reason },
  });
  return product;
};

/** Start a product, from the lead's tool or the founder's panel. */
export const startProduct = (input: ProductDraft, by: string | null): Product => {
  const product = store.createProduct(input);
  publishActivity({
    employeeId: by,
    kind: "product.created",
    message: product.name,
    payload: { productId: product.id },
  });
  return product;
};

/** Turn autopilot on or off, from the HUD or the tray. */
export const setAutopilot = (on: boolean): Company => {
  const company = store.setAutopilot(on);
  publishActivity({ kind: "autopilot.changed", payload: { on } });
  return company;
};

export const ship = (
  task: Task,
  at: { runId: string; taskId: string; employeeId: string },
  summary: string,
): void => {
  const message = (summary || "shipped work").slice(0, 200);
  store.recordShip(task.productId, message);
  publishActivity({ ...at, kind: "ship", message });
  const ships = store.getCompany()?.ships ?? 0;
  if (ships > 0 && ships % 10 === 0) {
    postToRoom({ kind: "office" }, `🎉 Milestone: ${ships} things shipped — keep going!`);
  }
};

/** Pause autopilot at the cap; running turns finish and report their cost. */
export const haltForBudget = (company: Company, spentUsd = company.spentUsd): void => {
  if (!company.autopilot) {
    return;
  }
  store.setAutopilot(false);
  publishActivity({
    kind: "budget.exhausted",
    payload: { budget: company.budget, spentUsd },
  });
};
