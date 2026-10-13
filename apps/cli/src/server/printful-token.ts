import { rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./lib/fs";
import { HttpError } from "./lib/http";
import { rootDir } from "./paths";
import { printfulGet, printfulSays } from "./printful";
import type { PrintfulCredential } from "./printful";
import { PRINTFUL_TOKEN, deleteSecret, getSecret, setSecret } from "./secrets";
import { errorMessage } from "@repo/domain/errors";
import type { PrintfulTokenStatus } from "@repo/domain/integrations";
import { RefusalError } from "./refusal";

// The founder's private token, from developers.printful.com/tokens: main prices listings and
// places orders with it, and the renderer is told only which token and store are saved.

/** The one store the token sells through: no secret, so it is kept beside secrets.json, never in it. */
const storePath = (): string => path.join(rootDir(), "printful-store.json");

/** Printable ASCII with no space: anything else would fail in the Authorization header, and fetch's refusal quotes the token. */
const PRIVATE_TOKEN = /^[!-~]{16,512}$/u;

const StoreSchema = z.object({ id: z.number().int(), name: z.string() });
type PrintfulStore = z.infer<typeof StoreSchema>;

const ScopesSchema = z.object({ data: z.array(z.object({ value: z.string() })) });
const StoresSchema = z.object({
  data: z.array(StoreSchema),
  paging: z.object({ total: z.number() }).optional(),
});

const savedStore = (): PrintfulStore | null => readJsonFile(storePath(), StoreSchema);

const keepStore = (store: PrintfulStore | null): void => {
  if (store === null) {
    rmSync(storePath(), { force: true });
  } else {
    writeJsonFile(storePath(), store);
  }
};

/** The token and its store, or null while either is missing: neither sells alone. */
export const printfulCredential = (): PrintfulCredential | null => {
  const token = getSecret(PRINTFUL_TOKEN);
  const store = savedStore();
  return token && store ? { storeId: store.id, token } : null;
};

export const printfulTokenStatus = (): PrintfulTokenStatus => {
  const token = getSecret(PRINTFUL_TOKEN);
  const store = savedStore();
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
    scopes = ScopesSchema.parse(await printfulGet("/v2/oauth-scopes", { token }));
    stores = StoresSchema.parse(await printfulGet("/v2/stores", { token }));
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
  // The store goes first and is put back as it was if the token can't be kept, so a failed
  // write never leaves a token selling through the last token's store, or a store with none.
  const before = savedStore();
  keepStore(store);
  try {
    setSecret(PRINTFUL_TOKEN, token);
  } catch (error) {
    keepStore(before);
    throw error;
  }
};

/** The token goes first: a store left by a failure is one no token sells through, which reads as none. */
export const removePrintfulToken = (): void => {
  deleteSecret(PRINTFUL_TOKEN);
  keepStore(null);
};
