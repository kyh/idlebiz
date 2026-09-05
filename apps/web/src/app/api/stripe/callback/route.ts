import { loopbackUrl, parseState } from "@repo/stripe-connect-protocol/protocol";
import { exchangeCode } from "@/lib/stripe-oauth";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = parseState(url.searchParams.get("state"));
  if (!state) return new Response("invalid state", { status: 400 });
  const back = (outcome: Parameters<typeof loopbackUrl>[1]): Response =>
    Response.redirect(loopbackUrl(state, outcome), 302);

  // founder cancelled (or Stripe errored) — tell the game so it stops waiting
  const flowError = url.searchParams.get("error");
  if (flowError) return back({ kind: "failed", error: flowError });

  const code = url.searchParams.get("code");
  if (!code) return back({ kind: "failed", error: "missing_code" });

  try {
    const result = await exchangeCode(code);
    return back({ kind: "connected", ...result });
  } catch (err) {
    return back({ kind: "failed", error: err instanceof Error ? err.message : "exchange_failed" });
  }
}
