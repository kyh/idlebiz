import { z } from "zod";
import { isLead } from "@repo/domain/domain";
import type {
  BlockedAsk,
  Company,
  Employee,
  IntegrationKind,
  TaskOrigin,
} from "@repo/domain/domain";
import { BadRequestError, errorMessage } from "@repo/domain/errors";
import type { HoldRuleId } from "@repo/domain/hold-rules";
import type { JsonValue } from "@repo/domain/json";
import type { AskBox } from "../agents/ask-box";
import type { agentDriver } from "../agents/runner-pool";
import { postToRoom } from "../company-actions";
import type { Deployer } from "../deploy";
import { report } from "../lib/report";
import type { PrintListing } from "../print-listing";
import { RefusalError } from "../refusal";
import * as store from "../store/store";
import type { PaymentLinker, StripeAccess } from "../stripe-links";
import type { ToolName, ToolOutcome, ToolSpec } from "../tool-specs";
import type { productionHosts, validateToken } from "../vercel";
import type { EnvSetter } from "../vercel-env";

/**
 * What only main can do for a tool call: every outward call made with one of the founder's keys,
 * which the run never holds. Boot makes the real ones; tests hand in fakes.
 */
export interface Integrations {
  /** Deploy to Vercel. */
  deploy: Deployer;
  /** Make a payment link on Stripe. */
  createPaymentLink: PaymentLinker;
  /** Ask Stripe whether the key still reaches payment links, before a sign-off is spent on one. */
  linkAccess: (key: string) => Promise<StripeAccess>;
  /** Ask Stripe whether the key reads checkouts, as a link owed a delivery needs. */
  checkoutAccess: (key: string) => Promise<StripeAccess>;
  /** Set a product project's variable on Vercel. */
  setEnv: EnvSetter;
  /** Ask Vercel whether it still takes the token, before a sign-off is spent on a deploy. */
  checkVercelToken: typeof validateToken;
  /** List a print-on-demand item with Printful and Stripe. */
  printListing: PrintListing;
  /** Read where a product's production deploys are served. */
  productionHosts: typeof productionHosts;
}

/** What a tool call acts on behalf of: who is running, for what, and what only main can do for it. */
export interface RunContext extends Integrations {
  employee: Employee;
  company: Company;
  run: {
    runId: string;
    taskId: string;
    productId: string | null;
    betId: string | null;
    origin: TaskOrigin;
  };
  asks: AskBox;
  driver: Pick<typeof agentDriver, "pickRunner" | "restingRunner" | "signedIn">;
  /** Queue a task for a teammate; a busy one picks it up on a later tick. */
  assign: (taskId: string, employeeId: string) => void;
}

/** A tool ready to be called, by its name, with whatever the agent sent. */
export type Tool = (ctx: RunContext, name: ToolName, raw: JsonValue) => Promise<ToolOutcome>;

/**
 * A call held for the founder, worded like a refusal as the sentence the agent reads: what it
 * asked is not turned down, but waits on their answer.
 */
class HeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeldError";
  }
}

/**
 * An implementation bound to its spec, so the body it receives is the one the spec parses, and
 * every way the call ends is an outcome its verb exits by. What the implementation returns is
 * done. The lead's tools turn anyone else away, and the store's refusals, written as the sentence
 * the agent should read, are refused; a hold for the founder is held. A body that does not parse
 * is the caller's error. A fault answers too, so the run can go on, but is reported.
 */
export const define =
  <B extends z.ZodType>(
    spec: ToolSpec<B>,
    run: (ctx: RunContext, body: z.infer<B>) => string | Promise<string>,
  ): Tool =>
  async (ctx, name, raw) => {
    if (spec.leadOnly !== null && !isLead(ctx.company, ctx.employee)) {
      return { kind: "refused", text: spec.leadOnly };
    }
    const body = spec.body.safeParse(raw);
    if (!body.success) {
      throw new BadRequestError(z.prettifyError(body.error));
    }
    try {
      return { kind: "done", text: await run(ctx, body.data) };
    } catch (error) {
      if (error instanceof HeldError) {
        return { kind: "held", text: error.message };
      }
      if (error instanceof RefusalError) {
        return { kind: "refused", text: error.message };
      }
      report(`tool ${name}`, error);
      return { kind: "fault", text: errorMessage(error) };
    }
  };

export const post = (ctx: RunContext, text: string, to: string | null = null): void => {
  postToRoom({ id: ctx.employee.id, kind: "employee" }, text, to);
};

/** The product a tool means: the one it names, else the run's own, else the one waited on longest. */
export const productFor = (ctx: RunContext, named: string | undefined): string | null =>
  named ?? ctx.run.productId ?? store.attentionProduct()?.id ?? null;

const UNSENT =
  "The founder was not asked: this run already asked them something, and only a run's first ask reaches them. Note it, and try again once they answer.";

/**
 * Leave the founder `ask` and answer `sent`. Only a run's first ask reaches them, so one that
 * does not is refused, after `why` it was needed.
 */
export const askFounder = (ctx: RunContext, ask: BlockedAsk, sent: string, why = ""): string => {
  if (!ctx.asks.raise(ask)) {
    throw new RefusalError(`${why} ${UNSENT}`.trim());
  }
  return sent;
};

/** Leave the founder `ask` and hold the call on their answer, saying `sent`; see askFounder. */
export const holdFor = (ctx: RunContext, ask: BlockedAsk, sent: string, why: string): never => {
  throw new HeldError(askFounder(ctx, ask, sent, why));
};

/**
 * Spend the founder's sign-off on `action` in this task, or ask them for it and
 * hold the call. The action is the approval's key, so it reads as what is signed.
 */
export const requireSignOff = (ctx: RunContext, action: string, rule: HoldRuleId): void => {
  if (store.consumeApproval(ctx.run.taskId, action)) {
    return;
  }
  const held = `Held for the founder's sign-off on "${action}".`;
  holdFor(
    ctx,
    { command: action, rule, type: "approval" },
    `${held} End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    held,
  );
};

/** Ask the founder for an integration, holding the call with what the agent should read. */
export const needIntegration = (
  ctx: RunContext,
  integration: Exclude<IntegrationKind, "vercel">,
  reason: string,
  sent: string,
  why: string,
): never => holdFor(ctx, { integration, productId: null, reason, type: "integration" }, sent, why);
