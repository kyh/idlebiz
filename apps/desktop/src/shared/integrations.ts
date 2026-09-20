/** Stripe Connect link state, streamed to the renderer. */
export type StripeStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected"; accountId: string; livemode: boolean }
  | { state: "error"; message: string };

/** A Vercel project the founder can bind the company to. */
export interface VercelProject {
  id: string;
  name: string;
  teamId?: string;
}

/** The latest production deployment of the bound Vercel project. */
export interface VercelDeployment {
  url: string;
  state: string;
  createdAt: number;
}

export interface ProductStatus {
  /** PRODUCT.md `entry:` value (path or URL), if the team wrote one. */
  entry: string | null;
  /** Latest production deployment when Vercel is connected. */
  deploy: VercelDeployment | null;
}
