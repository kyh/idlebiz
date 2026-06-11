import { parseState } from "@/lib/stripe-oauth";

export function GET(req: Request): Response {
  const url = new URL(req.url);
  const rawState = url.searchParams.get("state");
  if (!parseState(rawState) || rawState === null) {
    return new Response("invalid state", { status: 400 });
  }
  const clientId = process.env.STRIPE_CLIENT_ID;
  if (!clientId) return new Response("stripe not configured", { status: 500 });

  const authorize = new URL("https://connect.stripe.com/oauth/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("scope", "read_only");
  authorize.searchParams.set("redirect_uri", `${url.origin}/api/stripe/callback`);
  authorize.searchParams.set("state", rawState);
  return Response.redirect(authorize.toString(), 302);
}
