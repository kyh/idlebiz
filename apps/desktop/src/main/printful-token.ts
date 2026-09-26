import { z } from "zod";
import { HttpError } from "@/main/lib/http";
import { printfulGet, printfulSays, printfulStore } from "@/main/printful";
import { PRINTFUL_STORE, PRINTFUL_TOKEN, deleteSecret, getSecret, setSecret } from "@/main/secrets";
import { errorMessage } from "@/shared/errors";
import type { PrintfulTokenStatus } from "@/shared/integrations";
import { RefusalError } from "@/shared/refusal";

// The founder's private token, from developers.printful.com/tokens: main prices listings and
// places orders with it, and the renderer is told only which token and store are saved.

/** Printable ASCII with no space: anything else would fail in the Authorization header, and fetch's refusal quotes the token. */
const PRIVATE_TOKEN = /^[!-~]{16,512}$/u;

const ScopesSchema = z.object({ data: z.array(z.object({ value: z.string() })) });
const StoresSchema = z.object({
  data: z.array(z.object({ id: z.number().int(), name: z.string() })),
  paging: z.object({ total: z.number() }).optional(),
});

export const printfulTokenStatus = (): PrintfulTokenStatus => {
  const token = getSecret(PRINTFUL_TOKEN);
  const store = printfulStore();
  return token && store
    ? { last4: token.slice(-4), state: "set", store: store.name }
    : { state: "unset" };
};

const NEW_TOKEN = "create a private token at developers.printful.com/tokens";

/** Why Printful turned a token away, as the founder should read it. */
const turnedAway = (error: HttpError): string =>
  error.refused
    ? `Printful doesn't take this token, which happens once one expires — ${NEW_TOKEN} and paste it.`
    : `${printfulSays(error)} — nothing was saved; try again.`;

/**
 * Keep `token` once Printful shows it can place orders in exactly one store; refused, nothing
 * is saved. One store, because the token is asked which it sells through only here.
 */
export const savePrintfulToken = async (token: string): Promise<void> => {
  if (!PRIVATE_TOKEN.test(token)) {
    throw new RefusalError(`That isn't a Printful token — ${NEW_TOKEN} and paste it whole.`);
  }
  let scopes: z.infer<typeof ScopesSchema>;
  let stores: z.infer<typeof StoresSchema>;
  try {
    scopes = ScopesSchema.parse(await printfulGet("/v2/oauth-scopes", token));
    stores = StoresSchema.parse(await printfulGet("/v2/stores", token));
  } catch (error) {
    throw new RefusalError(
      error instanceof HttpError
        ? turnedAway(error)
        : `Printful couldn't be reached (${errorMessage(error)}) — nothing was saved; try again.`,
    );
  }
  if (!scopes.data.some((scope) => scope.value === "orders")) {
    throw new RefusalError(
      `This token can't place orders — ${NEW_TOKEN} with the "View and manage orders" scope.`,
    );
  }
  const count = stores.paging?.total ?? stores.data.length;
  const [store] = stores.data;
  if (store === undefined) {
    throw new RefusalError(
      'This token reaches no Printful store — add a "Manual order platform / API" store in Printful, then make a token for it.',
    );
  }
  if (count > 1) {
    throw new RefusalError(
      `This token reaches ${count} Printful stores — make one for the single store IdleBiz sells through, such as a "Manual order platform / API" store.`,
    );
  }
  setSecret(PRINTFUL_TOKEN, token);
  setSecret(PRINTFUL_STORE, JSON.stringify(store));
};

export const removePrintfulToken = (): void => {
  deleteSecret(PRINTFUL_TOKEN);
  deleteSecret(PRINTFUL_STORE);
};
