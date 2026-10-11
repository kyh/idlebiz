import type { Product, VercelBinding } from "@repo/domain/domain";
import { formatCents } from "@repo/domain/format";
import { makingPaymentLink } from "../company-actions";
import { CATALOG_PAGE } from "../listing";
import type { ListedPlacement, ListingVariant, PrintPlacement } from "../listing";
import { STRIPE_FEE_LABEL, priceFloorCents } from "../print-listing";
import type { CatalogProduct, PrintQuote, PrintfulCredential, QuoteRequest } from "../printful";
import { printfulCredential } from "../printful-token";
import { RefusalError } from "../refusal";
import { STRIPE_SECRET_KEY, VERCEL_TOKEN, getSecret } from "../secrets";
import * as store from "../store/store";
import { isTestKey } from "../stripe-api";
import { TOOL_SPECS } from "../tool-specs";
import type { ToolName } from "../tool-specs";
import { define, needIntegration, post, productFor, requireSignOff } from "./define";
import type { RunContext, Tool } from "./define";
import {
  NO_STRIPE_KEY,
  TEST_MODE,
  UNRECORDED_LINK,
  madeWhileRetiring,
  requireStripeAccess,
  revenueBetRefusal,
  stripeTurnedAway,
} from "./money";
import type { StripeGrant } from "./money";
import { VERCEL_WAITING, domainsLabel, needVercel, productHosts } from "./vercel";

const NO_PRINTFUL_TOKEN =
  "IdleBiz has no Printful token: the founder has a Printful card waiting that takes them to the Budget panel to add one. Continue with what you can — this task resumes automatically once the token is saved.";

/** Why a print file's URL is not one Printful can fetch, or null when it is. */
const fileUrlRefusal = (url: URL): string | null => {
  if (url.protocol !== "https:") {
    return `${url.href} is not https: Printful fetches a print file only from a public https URL on the product's own domain.`;
  }
  if (url.username !== "" || url.password !== "") {
    return `${url.href} carries a login: a print file has to be public, since Printful fetches it with none.`;
  }
  if (url.port !== "") {
    return `${url.href} names port ${url.port}: Vercel serves the product only on https's own port, so name the URL without one.`;
  }
  return null;
};

/**
 * Each placement with its file's URL as Printful will fetch it, so the file named in the
 * sign-off and the listing is that one; a URL Printful should not fetch ends the call.
 */
const printFileUrls = (placements: readonly PrintPlacement[]): PrintPlacement[] =>
  placements.map((p) => {
    const url = new URL(p.fileUrl);
    const refusal = fileUrlRefusal(url);
    if (refusal !== null) {
      throw new RefusalError(refusal);
    }
    return { ...p, fileUrl: url.href };
  });

/** The founder's keys a listing is made with. */
interface SellingKeys {
  vercel: string;
  stripe: string;
  printful: PrintfulCredential;
}

/** The keys a listing is made with; the first one missing is asked for, which ends the call. */
const sellingKeys = (
  ctx: RunContext,
  product: Product,
  name: string,
  price: string,
): SellingKeys => {
  const vercel =
    getSecret(VERCEL_TOKEN) ??
    needVercel(
      ctx,
      product.id,
      `to check where ${product.name} serves its print files`,
      VERCEL_WAITING,
      "Vercel is not connected.",
    );
  const stripe =
    getSecret(STRIPE_SECRET_KEY) ??
    needIntegration(
      ctx,
      "stripe",
      `to sell ${JSON.stringify(name)} at ${price} through a payment link`,
      NO_STRIPE_KEY,
      "IdleBiz has no Stripe key to charge with.",
    );
  const printful =
    printfulCredential() ??
    needIntegration(
      ctx,
      "printful",
      `to print and ship ${JSON.stringify(name)}`,
      NO_PRINTFUL_TOKEN,
      "IdleBiz has no Printful token.",
    );
  return { printful, stripe, vercel };
};

/**
 * Each placement with the digest of the image the product serves at its URL on its production
 * domains right now; any other file ends the call.
 */
const servedFiles = async (
  ctx: RunContext,
  product: Product,
  binding: VercelBinding,
  token: string,
  placements: readonly PrintPlacement[],
): Promise<ListedPlacement[]> => {
  const hosts = await productHosts(ctx, product, binding, token);
  const served: ListedPlacement[] = [];
  for (const placement of placements) {
    const { fileUrl } = placement;
    if (!hosts.includes(new URL(fileUrl).hostname)) {
      throw new RefusalError(
        `${fileUrl} is not on ${product.name}'s production domains (${domainsLabel(hosts)}): Printful prints only a file the product itself serves, so deploy it there and name that URL.`,
      );
    }
    const file = await ctx.printListing.readFile(fileUrl);
    if (file.kind === "unfit") {
      throw new RefusalError(
        `Printful could not fetch ${fileUrl}: ${file.reason}. Deploy the print file first, and check it loads as an image.`,
      );
    }
    served.push({ ...placement, sha256: file.sha256 });
  }
  return served;
};

/** Ask the founder for a Printful token in place of one Printful turned away, which ends the call. */
const printfulTurnedAway = (ctx: RunContext): never =>
  needIntegration(
    ctx,
    "printful",
    "Printful turned IdleBiz's token away (tokens expire): paste a new one",
    "Printful turned IdleBiz's token away, which happens when it expires: the founder has a Printful card waiting to paste a new one. Continue with what you can — this task resumes automatically once it is saved.",
    "Printful turned IdleBiz's token away.",
  );

/** Printful's price for a listing; a token it turns away is asked for anew, which ends the call. */
const quotePrint = async (ctx: RunContext, req: QuoteRequest): Promise<PrintQuote> => {
  const quoted = await ctx.printListing.quote(req);
  switch (quoted.kind) {
    case "quoted": {
      return quoted.quote;
    }
    case "refused": {
      return printfulTurnedAway(ctx);
    }
    case "failed": {
      throw new RefusalError(`Printful could not price it: ${quoted.reason}`);
    }
    // no default
  }
};

const PRINT_GRANT: StripeGrant = {
  can: "make shipping rates or read checkouts and charges",
  permissions: "Write on Shipping Rates, and Read on Checkout Sessions and Charges",
  why: "which selling a print needs",
};

const LISTING_GRANT: StripeGrant = {
  can: "make payment links or shipping rates",
  permissions: "Write on Payment Links, Prices, Products and Shipping Rates",
  why: "which selling a print needs",
};

/** One page of Printful's catalog, a product a line, with how to read the next. */
const catalogPage = ({
  offset,
  products,
  total,
}: {
  offset: number;
  products: readonly CatalogProduct[];
  total: number;
}): string => {
  if (offset >= total) {
    return `Printful's catalog lists ${total} products that ship to the US, so none from ${offset + 1}.`;
  }
  const next = offset + CATALOG_PAGE;
  const more = next < total ? ` Pass "offset":${next} for the next page.` : "";
  const lines = products.map((p) => {
    const made = [p.brand, p.model].filter(Boolean).join(" ");
    const how = p.techniques.map((t) => t.key).join(", ");
    return `${p.id}: ${p.name}${made ? ` (${made})` : ""}${how ? ` — ${how}` : ""}`;
  });
  return `Printful's catalog, from product ${offset + 1} of ${total} that ship to the US (id: name — techniques; discontinued ones left out). Pass "product":<id> for its placements and variants.${more}\n${lines.join("\n")}`;
};

/** A catalog product as sell_print names it: its placements with their techniques, and its variants. */
const catalogProduct = (product: CatalogProduct, variants: readonly ListingVariant[]): string => {
  const placements = product.placements.map((p) => `${p.placement} (${p.technique})`);
  return `${product.id}: ${product.name}${product.is_discontinued === true ? " — discontinued, so it cannot be ordered" : ""}
Placements, as sell_print's placement (technique): ${placements.join(", ") || "none listed"}
Variants, as sell_print's variantIds (id: colour / size):
${variants.map((v) => `${v.id}: ${v.label}`).join("\n")}`;
};

export const PRINT_TOOLS = {
  printful_catalog: define(TOOL_SPECS.printful_catalog, async (ctx, { offset, product }) => {
    const credential =
      printfulCredential() ??
      needIntegration(
        ctx,
        "printful",
        "to read Printful's catalog for what to sell",
        NO_PRINTFUL_TOKEN,
        "IdleBiz has no Printful token.",
      );
    const read = await ctx.printListing.catalog(
      product === undefined ? { offset: offset ?? 0 } : { product },
      credential,
    );
    switch (read.kind) {
      case "products": {
        return catalogPage(read);
      }
      case "product": {
        return catalogProduct(read.product, read.variants);
      }
      case "refused": {
        return printfulTurnedAway(ctx);
      }
      case "failed": {
        throw new RefusalError(`Printful's catalog could not be read: ${read.reason}`);
      }
      // no default
    }
  }),
  sell_print: define(TOOL_SPECS.sell_print, async (ctx, body) => {
    const { bet, name, priceUsd, variantIds, product: named } = body;
    const productId = productFor(ctx, named);
    if (productId === null) {
      throw new RefusalError("There is no product to sell it on — create_product first.");
    }
    const product = store.getProduct(productId);
    if (!product) {
      throw new RefusalError(store.noSuchProduct(productId));
    }
    const notTheBet = bet === undefined ? null : revenueBetRefusal(bet, product);
    if (notTheBet !== null) {
      throw new RefusalError(notTheBet);
    }
    const urls = printFileUrls(body.placements);
    if (product.vercel === null) {
      throw new RefusalError(
        `${product.name} has no Vercel project yet: deploy it with the print file, which makes one, then list it.`,
      );
    }
    const priceCents = Math.round(priceUsd * 100);
    const price = formatCents(priceCents);
    const keys = sellingKeys(ctx, product, name, price);
    const placements = await servedFiles(ctx, product, product.vercel, keys.vercel, urls);
    const quote = await quotePrint(ctx, {
      credential: keys.printful,
      placements,
      retailCents: priceCents,
      variantIds,
    });
    const floor = priceFloorCents(quote);
    const shipping = formatCents(quote.shippingCents);
    if (priceCents < floor) {
      throw new RefusalError(
        `${price} would lose money on every sale: Printful charges up to ${formatCents(quote.costCents)} to print one sold at that price and ship it to the US addresses IdleBiz prices it for, the buyer pays ${shipping} of that as shipping, and Stripe keeps up to ${STRIPE_FEE_LABEL}. Every price under ${formatCents(floor)} loses money: price it above that, with the margin the bet needs.`,
      );
    }
    await requireStripeAccess(ctx, ctx.printListing.stripeAccess(keys.stripe), PRINT_GRANT);
    // the digest pins the design the founder signs for: a later deploy can change what the URL serves
    const printed = placements
      .map((p) => `${p.placement} (${p.technique}) ${p.fileUrl} sha256:${p.sha256}`)
      .join(", ");
    // quoted as JSON, so a name cannot pose as more of the action the founder signs
    const action = `sell ${JSON.stringify(name)} (variants ${variantIds.join(", ")}) printing ${printed} at ${price} via Printful on ${product.id}${bet === undefined ? "" : ` for bet ${bet}`}`;
    requireSignOff(ctx, action, "payments");
    const listingId = store.newListingId(name);
    const kept = makingPaymentLink();
    try {
      const made = await ctx.printListing.publish({
        bet: bet ?? null,
        key: keys.stripe,
        listing: listingId,
        name,
        priceCents,
        product: product.id,
        shippingCents: quote.shippingCents,
        variants: quote.variants,
      });
      if (made.kind === "refused") {
        return stripeTurnedAway(ctx, LISTING_GRANT, made.said);
      }
      if (made.kind === "failed") {
        throw new RefusalError(`Stripe made no payment link: ${made.error}`);
      }
      if (made.kind === "unrecorded") {
        throw new RefusalError(UNRECORDED_LINK);
      }
      store.recordListing({
        betId: bet ?? null,
        costCents: quote.costCents,
        createdAt: Date.now(),
        id: listingId,
        livemode: !isTestKey(keys.stripe),
        name,
        paymentLink: { id: made.id, state: { kind: "selling" }, url: made.url },
        placements,
        priceCents,
        productId: product.id,
        shippingCents: quote.shippingCents,
        variants: quote.variants,
      });
      const retired = await madeWhileRetiring(product, made.id);
      if (retired !== null) {
        throw new RefusalError(retired);
      }
      post(ctx, `🛍️ listed "${name}" at ${price} on ${product.name}`);
      const testMode = isTestKey(keys.stripe) ? TEST_MODE : "";
      return `Listed "${name}" on ${product.name} at ${price} plus ${shipping} shipping, US addresses only: ${made.url}\nPrintful charges up to ${formatCents(quote.costCents)} to print and ship each one to the US addresses IdleBiz priced it for; a buyer where tax runs higher costs more, and an order that would cost Printful more than it took waits on the founder. Each paid order goes to Printful on its own; read_orders shows them.${testMode}`;
    } finally {
      kept();
      store.releaseListingId(listingId);
    }
  }),
} satisfies Partial<Record<ToolName, Tool>>;
