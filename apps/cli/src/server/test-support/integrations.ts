import type { Integrations } from "../tools/define";

/** A call out a test never meant to make: it fails, saying what it would have done. */
const unasked = (what: string) => () =>
  Promise.reject(new Error(`${what} without a test asking for it`));

/** No test calls out with a founder's key: one that means to overrides that call alone. */
export const unaskedIntegrations: Integrations = {
  checkVercelToken: unasked("checked the Vercel token"),
  checkoutAccess: unasked("read checkouts"),
  createPaymentLink: unasked("made a payment link"),
  deploy: unasked("deployed"),
  linkAccess: unasked("read payment links"),
  printListing: {
    catalog: unasked("read the catalog"),
    publish: unasked("listed a print"),
    quote: unasked("priced a print"),
    readFile: unasked("fetched a print file"),
    stripeAccess: unasked("read Stripe's grants"),
  },
  productionHosts: unasked("read domains"),
  setEnv: unasked("set a variable"),
};
