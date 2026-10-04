/** Stripe Connect link state, streamed to the renderer. */
export type StripeStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected"; accountId: string; livemode: boolean }
  /** `bound` while main still holds a Connect grant, which a disconnect drops. */
  | { state: "error"; message: string; bound: boolean };

/** The founder's own Stripe key as the renderer sees it: enough to tell which key it is, never the key. */
export type StripeKeyStatus =
  | { state: "unset" }
  | { state: "set"; last4: string; livemode: boolean };

/** The founder's Printful token as the renderer sees it: its last four and the store it sells through. */
export type PrintfulTokenStatus =
  | { state: "unset" }
  | { state: "set"; last4: string; store: string };

/** A Vercel project the founder can bind the company to. */
export interface VercelProject {
  id: string;
  name: string;
  teamId?: string;
  /** Its team's name, which tells it from a same-named project elsewhere. */
  teamName?: string;
}

/**
 * What listing a token's Vercel projects found. A token Vercel refuses, or none
 * at all, is told apart from Vercel being out of reach: only the first needs a
 * new token.
 */
export type VercelListing =
  | { kind: "loaded"; account: string | undefined; projects: VercelProject[] }
  | { kind: "rejected" }
  | { kind: "unreachable"; reason: string };

/** The latest production deployment of the bound Vercel project. */
export interface VercelDeployment {
  url: string;
  state: string;
  createdAt: number;
}

/**
 * What asking Vercel for a bound project's latest deploy found. A refused token
 * is told apart from "nothing deployed": it silently stops every read of the
 * product, so the founder has to see it to reconnect.
 */
export type DeployRead =
  | { kind: "deployed"; deployment: VercelDeployment }
  | { kind: "none" }
  | { kind: "refused" };

export interface ProductStatus {
  /** PRODUCT.md `entry:` value (path or URL), if the team wrote one. */
  entry: string | null;
  /** Null when the product is bound to no Vercel project. */
  deploy: DeployRead | null;
}
