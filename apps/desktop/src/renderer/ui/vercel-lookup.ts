import type { Loaded } from "@/renderer/hooks/use-async";
import type { VercelListing, VercelProject } from "@/shared/integrations";

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

export const problemOf = (lookup: Lookup): string | null => {
  if (lookup.state === "error") {
    return lookup.message;
  }
  if (lookup.state === "loaded" && lookup.projects.length === 0) {
    return "No projects on this account yet.";
  }
  return null;
};
