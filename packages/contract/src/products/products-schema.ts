import { z } from "zod";
import { KillReasonSchema } from "@repo/domain/domain";

export { ProductDraftSchema as createProductInput } from "@repo/domain/domain";
export const killProductInput = z.object({ productId: z.string(), reason: KillReasonSchema });
export const openProductInput = z.object({ productId: z.string() });
export const productStatusInput = z.object({ productId: z.string() });
