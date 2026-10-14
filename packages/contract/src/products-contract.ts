// The products the company runs: the list, a new one, one's status, opening one and retiring one.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import { KillReasonSchema, ProductDraftSchema } from "@repo/domain/domain";
import type { Product } from "@repo/domain/domain";
import type { ProductStatus } from "@repo/domain/integrations";

export const productsContract = {
  create: oc.input(ProductDraftSchema).output(type<Product>()),
  /** Retires a product. */
  kill: oc
    .input(z.object({ productId: z.string(), reason: KillReasonSchema }))
    .output(type<Product>()),
  list: oc.output(type<Product[]>()),
  /** Opens a product's workspace, answering what opened. */
  open: oc.input(z.object({ productId: z.string() })).output(type<{ opened: string }>()),
  status: oc.input(z.object({ productId: z.string() })).output(type<ProductStatus>()),
};
