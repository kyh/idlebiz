// The products the company runs: the list, a new one, one's status, opening one and retiring one.

import { oc, type } from "@orpc/contract";
import type { Product } from "@repo/domain/domain";
import type { ProductStatus } from "@repo/domain/integrations";
import {
  createProductInput,
  killProductInput,
  openProductInput,
  productStatusInput,
} from "./products-schema";

export const productsContract = {
  create: oc.input(createProductInput).output(type<Product>()),
  /** Retires a product. */
  kill: oc.input(killProductInput).output(type<Product>()),
  list: oc.output(type<Product[]>()),
  /** Opens a product's workspace, answering what opened. */
  open: oc.input(openProductInput).output(type<{ opened: string }>()),
  status: oc.input(productStatusInput).output(type<ProductStatus>()),
};
