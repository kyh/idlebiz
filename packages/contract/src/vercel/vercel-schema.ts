import { z } from "zod";

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
export const disconnectInput = z.object({ productId: z.string() });
export const projectsInput = z.object({ token: VercelTokenSchema.optional() });
export const saveTokenInput = z.object({ productId: z.string(), token: VercelTokenSchema });
