import { exchangeCode, loopbackUrl, parseState } from "@/lib/stripe-oauth";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = parseState(url.searchParams.get("state"));
  if (!state) return new Response("invalid state", { status: 400 });

  // founder cancelled (or Stripe errored) — tell the game so it stops waiting
  const flowError = url.searchParams.get("error");
  if (flowError) {
    return Response.redirect(loopbackUrl(state, { error: flowError }), 302);
  }

  const code = url.searchParams.get("code");
  if (!code) return Response.redirect(loopbackUrl(state, { error: "missing_code" }), 302);

  try {
    const result = await exchangeCode(code);
    return Response.redirect(
      loopbackUrl(state, {
        access_token: result.accessToken,
        stripe_user_id: result.stripeUserId,
        livemode: String(result.livemode),
      }),
      302,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "exchange_failed";
    return Response.redirect(loopbackUrl(state, { error: message }), 302);
  }
}
