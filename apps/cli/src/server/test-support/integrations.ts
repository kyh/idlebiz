import type { Integrations } from "../tools/define";

/** A call out a test never meant to make: it fails, saying what it would have done. */
const unasked = (what: string) => () =>
  Promise.reject(new Error(`${what} without a test asking for it`));

/** No test calls out with a founder's key: one that means to overrides that call alone. */
export const unaskedIntegrations: Integrations = {
  checkVercelToken: unasked("checked the Vercel token"),
  checkoutAccess: unasked("read checkouts"),
  createPaymentLink: unasked("made a payment link"),
  createPrintLink: unasked("listed a print"),
  deploy: unasked("deployed"),
  linkAccess: unasked("read payment links"),
  listingAccess: unasked("read Stripe's grants"),
  printCatalog: unasked("read the catalog"),
  productionHosts: unasked("read domains"),
  quotePrint: unasked("priced a print"),
  readPrintFile: unasked("fetched a print file"),
  setEnv: unasked("set a variable"),
};
