import { CALLBACK_PATH, encodeState, parseState } from "@repo/stripe-connect-protocol/protocol";
import { env } from "@/lib/env";
import { siteConfig } from "@/lib/site-config";

export function GET(req: Request): Response {
  const url = new URL(req.url);
  const state = parseState(url.searchParams.get("state"));
  if (!state) return new Response("invalid state", { status: 400 });
  const clientId = env.STRIPE_CLIENT_ID;
  if (!clientId) return new Response("stripe not configured", { status: 500 });

  const authorize = new URL("https://connect.stripe.com/oauth/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("scope", "read_only");
  // the site's own origin, never the request's Host header
  authorize.searchParams.set("redirect_uri", new URL(CALLBACK_PATH, siteConfig.url).toString());
  authorize.searchParams.set("state", encodeState(state));
  return Response.redirect(authorize.toString(), 302);
}
