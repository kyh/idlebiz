import { loopbackUrl, parseState } from "@repo/stripe-connect-protocol/protocol";
import { seal } from "@repo/stripe-connect-protocol/seal";
import { exchangeCode } from "@/lib/stripe-oauth";

export const GET = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const state = parseState(url.searchParams.get("state"));
  if (!state) {
    return new Response("invalid state", { status: 400 });
  }
  const back = (outcome: Parameters<typeof loopbackUrl>[1]): Response =>
    Response.redirect(loopbackUrl(state, outcome), 302);

  // founder cancelled (or Stripe errored) — tell the game so it stops waiting
  const flowError = url.searchParams.get("error");
  if (flowError) {
    return back({ error: flowError, kind: "failed" });
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return back({ error: "missing_code", kind: "failed" });
  }

  try {
    // sealed to the key the desktop put in the state: the token never rides a URL in the clear
    const sealed = await seal(state.key, await exchangeCode(code));
    return back({ kind: "sealed", sealed });
  } catch (error) {
    return back({
      error: error instanceof Error ? error.message : "exchange_failed",
      kind: "failed",
    });
  }
};
