/** The windows the HUD opens over the office; at most one is up at a time. */
export type Overlay =
  | { kind: "ships" }
  | { kind: "inbox" }
  | { kind: "teams" }
  | { kind: "budget" }
  | { kind: "settings" }
  | { kind: "vercel"; productId: string };
