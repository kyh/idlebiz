import type { Integrations } from "../tools/define";

const unasked = (what: string) => () =>
  Promise.reject(new Error(`${what} without a test asking for it`));

/** Every outward call with a founder's key, failing: a test overrides the ones it asks for. */
export const unaskedIntegrations = (): Integrations => ({
  checkVercelToken: unasked("asked Vercel about its token"),
  checkoutAccess: unasked("asked Stripe about checkouts"),
  createPaymentLink: unasked("charged"),
  createPrintLink: unasked("listed a print"),
  deploy: unasked("deployed"),
  linkAccess: unasked("asked Stripe about payment links"),
  listingAccess: unasked("asked Stripe about its grants"),
  printCatalog: unasked("read Printful's catalog"),
  productionHosts: unasked("asked Vercel for domains"),
  quotePrint: unasked("asked Printful for a price"),
  readPrintFile: unasked("fetched a print file"),
  setEnv: unasked("set a variable"),
});
