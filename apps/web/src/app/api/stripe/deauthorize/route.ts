import { DeauthorizeBodySchema } from "@repo/stripe-connect-protocol/protocol";
import { deauthorize, tokenOwner } from "@/lib/stripe-oauth";

export const POST = async (req: Request): Promise<Response> => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const body = DeauthorizeBodySchema.safeParse(raw);
  if (!body.success) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const { accessToken, stripeUserId } = body.data;

  // ownership check: only the holder of a valid token for this account may
  // disconnect it — keeps this endpoint from deauthorizing arbitrary accounts
  const owner = await tokenOwner(accessToken);
  if (owner.kind === "unreadable") {
    return Response.json({ error: owner.reason }, { status: 502 });
  }
  if (owner.kind === "dead" || owner.id !== stripeUserId) {
    return Response.json({ error: "not authorized for this account" }, { status: 403 });
  }

  try {
    await deauthorize(stripeUserId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "deauthorize failed";
    return Response.json({ error: message }, { status: 502 });
  }
  return Response.json({ ok: true });
};
