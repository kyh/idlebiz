import { betGoal } from "@repo/domain/bets";
import { announceBet, killBet, nameProduct, retireProduct, startProduct } from "../company-actions";
import { measureRefusal } from "../metrics";
import { betLedger, betMark } from "../prompts/briefs";
import { RefusalError } from "../refusal";
import * as store from "../store/store";
import { TOOL_SPECS } from "../tool-specs";
import type { ToolName } from "../tool-specs";
import { define, post, productFor } from "./define";
import type { Tool } from "./define";
import { linkEntry } from "./money";

// oxlint-disable-next-line sort-keys -- the order of TOOL_SPECS
export const PORTFOLIO_TOOLS = {
  read_bets: define(TOOL_SPECS.read_bets, () => betLedger(store.listBets())),
  create_product: define(TOOL_SPECS.create_product, (ctx, { name, description }) => {
    const product = startProduct({ description, name }, ctx.employee.id);
    post(ctx, `🆕 New product: ${product.name} — ${product.description}`);
    return `Created "${product.name}" (${product.id}); its workspace is ${product.workspaceDir}. Fund work on it with open_bet and "product":"${product.id}", then delegate against that bet.`;
  }),
  name_product: define(TOOL_SPECS.name_product, (ctx, { product: named, ...draft }) => {
    const productId = productFor(ctx, named);
    if (productId === null) {
      throw new RefusalError("There is no product to name — create_product first.");
    }
    const product = nameProduct(productId, draft, ctx.employee);
    return `${product.id} is now "${product.name}": ${product.description}`;
  }),
  kill_product: define(TOOL_SPECS.kill_product, async (ctx, { slug, reason }) => {
    const retired = await retireProduct(slug, reason, ctx.employee.id);
    const links = store
      .paymentLinks()
      .map(({ link }) => link)
      .filter((l) => l.productId === slug);
    const told =
      links.length === 0
        ? ""
        : ` Its payment links: ${links.map(linkEntry).join("; ")}. Each order already paid still ships, and still counts.`;
    return `Retired ${retired.name}. Its package is archived under retired/; its deploy, if any, is still live until someone takes it down.${told}`;
  }),
  open_bet: define(TOOL_SPECS.open_bet, (ctx, { product, ...bet }) => {
    const productId = productFor(ctx, product);
    if (productId === null) {
      throw new RefusalError("There is no product to bet on — create_product first.");
    }
    const wager = bet.metric === "users" ? { ...bet, landingPath: bet.landingPath ?? null } : bet;
    const opened = store.openBet({ ...wager, productId });
    announceBet(opened);
    return `Opened "${opened.title}" (${opened.id}). ${betMark(opened)} Delegate work to it with "bet":"${opened.id}"; idle teammates pick it up on their own.`;
  }),
  measure_bet: define(TOOL_SPECS.measure_bet, (_ctx, { slug }) => {
    const named = store.getBet(slug);
    const refusal =
      named?.state.kind === "open"
        ? measureRefusal(named, store.getProduct(named.productId))
        : null;
    if (refusal !== null) {
      throw new RefusalError(refusal);
    }
    const bet = store.measureBet(slug, Date.now());
    announceBet(bet);
    return `"${bet.title}" is measuring: no more work is spent on it, and it has ${bet.windowHours}h to bring in ${betGoal(bet)}.`;
  }),
  kill_bet: define(TOOL_SPECS.kill_bet, (_ctx, { slug, reason }) => {
    const killed = killBet(slug, reason);
    return `Killed "${killed.title}". Its remaining budget is free for the next bet.`;
  }),
} satisfies Partial<Record<ToolName, Tool>>;
