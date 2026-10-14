// The founder's Vercel: the token, and which project each product deploys to.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type { VercelListing } from "@repo/domain/integrations";
import type { Done } from "./done";

/**
 * A Vercel token the founder pasted. Left out, the saved one is used: it serves every product, so
 * replacing it for one could cut another off.
 */
const VercelTokenSchema = z.string().trim().min(1);

export const connectInput = z.object({
  productId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  teamId: z.string().optional(),
  token: VercelTokenSchema.optional(),
});
export const saveTokenInput = z.object({ productId: z.string(), token: VercelTokenSchema });

export const vercelContract = {
  /** Binds a product to a project of the founder's. */
  connect: oc.input(connectInput).output(type<Done>()),
  disconnect: oc.input(z.object({ productId: z.string() })).output(type<Done>()),
  projects: oc
    .input(z.object({ token: VercelTokenSchema.optional() }))
    .output(type<VercelListing>()),
  saveToken: oc.input(saveTokenInput).output(type<Done>()),
};
