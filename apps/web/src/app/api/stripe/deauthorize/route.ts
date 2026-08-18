import { z } from "zod";
import { deauthorize, tokenAccountId } from "@/lib/stripe-oauth";

const deauthorizeBodySchema = z.object({
  accessToken: z.string(),
  stripeUserId: z.string(),
});

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const body = deauthorizeBodySchema.safeParse(raw);
  if (!body.success) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const { accessToken, stripeUserId } = body.data;

  // ownership check: only the holder of a valid token for this account may
  // disconnect it — keeps this endpoint from deauthorizing arbitrary accounts
  const owner = await tokenAccountId(accessToken);
  if (owner === null || owner !== stripeUserId) {
    return Response.json({ error: "not authorized for this account" }, { status: 403 });
  }

  try {
    await deauthorize(stripeUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "deauthorize failed";
    return Response.json({ error: message }, { status: 502 });
  }
  return Response.json({ ok: true });
}
