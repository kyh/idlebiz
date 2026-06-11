import { deauthorize, tokenAccountId } from "@/lib/stripe-oauth";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const o = body as { accessToken?: unknown; stripeUserId?: unknown };
  if (typeof o.accessToken !== "string" || typeof o.stripeUserId !== "string") {
    return Response.json({ error: "missing fields" }, { status: 400 });
  }

  // ownership check: only the holder of a valid token for this account may
  // disconnect it — keeps this endpoint from deauthorizing arbitrary accounts
  const owner = await tokenAccountId(o.accessToken);
  if (owner === null || owner !== o.stripeUserId) {
    return Response.json({ error: "not authorized for this account" }, { status: 403 });
  }

  try {
    await deauthorize(o.stripeUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "deauthorize failed";
    return Response.json({ error: message }, { status: 502 });
  }
  return Response.json({ ok: true });
}
