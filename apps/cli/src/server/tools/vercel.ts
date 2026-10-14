import type { Product, VercelBinding } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";
import { unshippableIn } from "../deploy";
import type { DeployTarget } from "../deploy";
import { publicPrefixOf, publicValueRefusal } from "../env-name";
import { RefusalError } from "../refusal";
import { VERCEL_TOKEN, getSecret, heldKeyIn, heldKeys } from "../secrets";
import * as store from "../store/store";
import { holdsStripeSecretKey } from "../stripe-api";
import { TOOL_SPECS } from "../tool-specs";
import type { ToolName } from "../tool-specs";
import { keepEnvValue, serverOnlyValueIn, teamSetEnv, unshippableEnvValues } from "../vercel-env";
import { define, holdOnFounder, post, productFor, requireSignOff } from "./define";
import type { RunContext, Tool } from "./define";

export const VERCEL_WAITING =
  "Vercel is not connected: the founder has a Vercel connect card waiting. Continue with what you can — this task resumes automatically once connected.";

/** Ask the founder for Vercel for `productId`, whose binding answers it, which holds the call. */
export const needVercel = (
  ctx: RunContext,
  productId: string,
  reason: string,
  sent: string,
  why: string,
): never =>
  holdOnFounder(ctx, { integration: "vercel", productId, reason, type: "integration" }, sent, why);

/** What the founder signs for a deploy: the product, and the Vercel project it lands in. */
const deployAction = (productId: string, target: DeployTarget): string =>
  target.kind === "bound"
    ? `deploy ${productId} to production on Vercel project ${target.binding.projectName}`
    : `deploy ${productId} to production on a new Vercel project named ${target.name}`;

/** Ask the founder for a Vercel token in place of one Vercel turned away `doing` something for `product`, which ends the call. */
const vercelTurnedAway = (ctx: RunContext, product: Product, doing: string): never =>
  needVercel(
    ctx,
    product.id,
    `Vercel turned IdleBiz's token away ${doing}`,
    "Vercel turned IdleBiz's token away: the founder has a Vercel card waiting to connect it again. Continue with what you can — this task resumes automatically once connected.",
    "Vercel turned IdleBiz's token away.",
  );

/** Vercel's word on `token`; one it cannot give ends the call. */
const vercelTakes = async (
  ctx: RunContext,
  token: string,
): ReturnType<RunContext["checkVercelToken"]> => {
  try {
    return await ctx.checkVercelToken(token);
  } catch (error) {
    throw new RefusalError(
      `Vercel could not be asked whether IdleBiz's token still works (${errorMessage(error)}); try again.`,
    );
  }
};

/** End the call unless Vercel still takes `token`; one it turns away (expired, revoked) is asked for anew. */
const requireLiveVercelToken = async (
  ctx: RunContext,
  product: Product,
  token: string,
  doing: string,
): Promise<void> => {
  const check = await vercelTakes(ctx, token);
  if (check.kind === "refused") {
    vercelTurnedAway(ctx, product, doing);
  }
};

/** The hosts `product` serves its production deploys on; a token Vercel turns away is asked for anew, which ends the call. */
export const productHosts = async (
  ctx: RunContext,
  product: Product,
  binding: VercelBinding,
  token: string,
): Promise<string[]> => {
  const read = await ctx.productionHosts(binding, token);
  if (read.kind === "refused") {
    return vercelTurnedAway(ctx, product, `while checking ${product.name}'s domains`);
  }
  if (read.kind === "unreachable") {
    throw new RefusalError(
      `Vercel could not say where ${product.name} is served (${read.reason}); try again.`,
    );
  }
  return read.hosts;
};

export const domainsLabel = (hosts: readonly string[]): string =>
  hosts.length === 0 ? "none yet" : hosts.join(", ");

export const VERCEL_TOOLS = {
  // A signed run has only its own product's folder to itself, so no other is shipped from it.
  deploy: define(TOOL_SPECS.deploy, async (ctx) => {
    const { productId } = ctx.run;
    if (productId === null) {
      throw new RefusalError(
        "Your run is on no product, so it has no folder to deploy: a deploy ships the folder of the run's own product, which that run builds and checks right before the call. Hand the deploy to a teammate on the product with delegate.",
      );
    }
    const product = store.getProduct(productId);
    if (!product) {
      throw new RefusalError(store.noSuchProduct(productId));
    }
    const token = getSecret(VERCEL_TOKEN);
    if (!token) {
      return holdOnFounder(
        ctx,
        {
          integration: "vercel",
          productId: product.id,
          reason: `to deploy ${product.name}`,
          type: "integration",
        },
        VERCEL_WAITING,
        "Vercel is not connected.",
      );
    }
    const target: DeployTarget =
      product.vercel === null
        ? { kind: "new", name: product.id }
        : { binding: product.vercel, kind: "bound" };
    const unshippable = [...unshippableEnvValues(), ...heldKeys()];
    const leak = await unshippableIn(product.workspaceDir, unshippable);
    if (leak !== null) {
      throw new RefusalError(leak);
    }
    await requireLiveVercelToken(ctx, product, token, `while deploying ${product.name}`);
    requireSignOff(ctx, deployAction(product.id, target), "deploy");
    const deployed = await ctx.deploy({ cwd: product.workspaceDir, target, token, unshippable });
    if (deployed.kind === "name-taken") {
      const refused = `Nothing was deployed: Vercel already has a project named "${deployed.name}", and ${product.name} is not bound to it.`;
      return holdOnFounder(
        ctx,
        {
          integration: "vercel",
          productId: product.id,
          reason: `to bind ${product.name} to its Vercel project: one named "${deployed.name}" already exists`,
          type: "integration",
        },
        `${refused} The founder has a Vercel card waiting to bind ${product.name} to its project; this task resumes once they do. Continue with what you can.`,
        refused,
      );
    }
    // a new project exists from its first deployment on, live or not
    const made = target.kind === "new" ? deployed.project : null;
    const binds = made !== null && store.getProduct(product.id)?.vercel === null ? made : null;
    if (binds !== null) {
      store.setProductVercel(product.id, binds);
    }
    const bindNote =
      binds === null
        ? ""
        : `\n${product.name} is now bound to the new Vercel project ${binds.projectName}, which counts its visitors.`;
    if (deployed.kind === "failed") {
      throw new RefusalError(`The deploy of ${product.name} failed: ${deployed.reason}${bindNote}`);
    }
    const live =
      deployed.alias === null
        ? deployed.url
        : `${deployed.alias} (this deployment: ${deployed.url})`;
    return `Deployed ${product.name} to production: ${live}${bindNote}`;
  }),
  set_env: define(TOOL_SPECS.set_env, async (ctx, { name, value, product: named }) => {
    const productId = productFor(ctx, named);
    if (productId === null) {
      throw new RefusalError("There is no product to set it on — create_product first.");
    }
    const product = store.getProduct(productId);
    if (!product) {
      throw new RefusalError(store.noSuchProduct(productId));
    }
    if (product.vercel === null) {
      throw new RefusalError(
        `${product.name} has no Vercel project yet: deploy it first, which makes one, then set ${name}.`,
      );
    }
    const token = getSecret(VERCEL_TOKEN);
    if (!token) {
      return holdOnFounder(
        ctx,
        {
          integration: "vercel",
          productId: product.id,
          reason: `to set ${name} on ${product.name}`,
          type: "integration",
        },
        VERCEL_WAITING,
        "Vercel is not connected.",
      );
    }
    const held = heldKeyIn(value);
    if (held !== null) {
      throw new RefusalError(
        `${name} was not set: that value is IdleBiz's own ${held}, which never leaves IdleBiz. What needs it is a tool IdleBiz runs itself (create_payment_link, sell_print, deploy); a key the product needs of its own is one the founder makes for it, which an ask_boss action can ask them for.`,
      );
    }
    if (holdsStripeSecretKey(value)) {
      throw new RefusalError(
        `${name} was not set: that value is a Stripe secret key (sk_), which can charge, refund and pay out on the founder's whole account, and no product holds one. Charging is create_payment_link's; a product that reads Stripe itself gets a restricted key (rk_) from the founder, granted only what it reads (see "Checking who paid").`,
      );
    }
    const exposed = publicValueRefusal(name, value);
    if (exposed !== null) {
      throw new RefusalError(exposed);
    }
    const prefix = publicPrefixOf(name);
    const kept = prefix === undefined ? null : serverOnlyValueIn(value);
    if (kept !== null) {
      throw new RefusalError(
        `${name} was not set: that value is the one set_env keeps as ${kept.name} on ${kept.product}, server-only, and a ${prefix} name would build it into the page, where every visitor reads it. Server code reads it as process.env.${kept.name}; a public name is only for what any visitor may see, such as a Stripe publishable key (pk_).`,
      );
    }
    await requireLiveVercelToken(ctx, product, token, `while setting ${name} on ${product.name}`);
    const replaces = teamSetEnv(product, product.vercel.projectId, name);
    const set = await ctx.setEnv({ binding: product.vercel, name, replaces, token, value });
    if (!set.ok) {
      const notOurs = replaces
        ? ""
        : `\nset_env only replaces a variable the team set: if ${product.vercel.projectName} already has ${name}, it is the founder's, so hand them an ask_boss action to change it.`;
      throw new RefusalError(`${name} was not set on ${product.name}: ${set.error}${notOurs}`);
    }
    keepEnvValue(product, product.vercel.projectId, name, value);
    post(ctx, `🔑 set ${name} on ${product.name}`);
    const where = `Set ${name} on ${product.name}'s Vercel project ${product.vercel.projectName}, for production and preview.`;
    return prefix === undefined
      ? `${where} It takes effect on the next deploy; server code reads it as process.env.${name}. Never write its value into a file: deploy refuses a folder that holds it.`
      : `${where} It takes effect on the next deploy, built into the page for every visitor to read only by a framework that reads the ${prefix} prefix: Next.js as process.env.NEXT_PUBLIC_…, Vite as import.meta.env.VITE_…, SvelteKit and Astro a PUBLIC_ name. Under any other framework it stays server-only, read as process.env.${name}, and no deploy refuses a file that holds it.`;
  }),
} satisfies Partial<Record<ToolName, Tool>>;
