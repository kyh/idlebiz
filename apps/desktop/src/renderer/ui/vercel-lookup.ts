import type { Loaded } from "@/renderer/hooks/use-async";
import type { BlockedAsk } from "@repo/domain/domain";
import type { VercelListing, VercelProject } from "@repo/domain/integrations";

type Lookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "loaded";
      account: string | undefined;
      projects: VercelProject[];
      /** The token that listed them; absent when it is the saved one. */
      token?: string;
    };

const lookupOf = (listing: VercelListing, token?: string): Lookup => {
  switch (listing.kind) {
    case "loaded": {
      return { account: listing.account, projects: listing.projects, state: "loaded", token };
    }
    case "rejected": {
      // A saved token that is refused, or missing, only means one has to be pasted.
      return token === undefined
        ? { state: "idle" }
        : {
            message: "That token was rejected — create one at vercel.com/account/tokens.",
            state: "error",
          };
    }
    case "unreachable": {
      return {
        message: `Couldn't reach Vercel — check your connection and try again. (${listing.reason})`,
        state: "error",
      };
    }
    // no default
  }
};

/**
 * How the picker shows the listing read for `token`, the one pasted — absent when
 * the saved one was tried. A listing for an older token is no answer yet.
 */
export const lookupFor = (listing: Loaded<VercelListing>, token?: string): Lookup => {
  switch (listing.kind) {
    case "loading": {
      return { state: "loading" };
    }
    case "failed": {
      return { message: listing.message, state: "error" };
    }
    case "ready": {
      return listing.current ? lookupOf(listing.value, token) : { state: "loading" };
    }
    // no default
  }
};

export const problemOf = (lookup: Lookup): string | null =>
  lookup.state === "error" ? lookup.message : null;

/**
 * Whether the team waits on Vercel for this product, or for one it never named. A bound product
 * then gets the picker back: Vercel may have turned the saved token away.
 */
export const awaitsVercelToken = (
  productId: string,
  asks: readonly { state: { ask: BlockedAsk } }[],
): boolean =>
  asks.some(
    ({ state: { ask } }) =>
      ask.type === "integration" &&
      ask.integration === "vercel" &&
      (ask.productId === productId || ask.productId === null),
  );
