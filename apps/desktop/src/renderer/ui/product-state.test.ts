import { expect, it } from "vitest";
import type { ProductStatus } from "@/shared/integrations";
import { deploymentOf, productStateOf } from "./product-state";

const deployment = { createdAt: 1, state: "READY", url: "https://acme.vercel.app" };

it("says a refused token needs a reconnect, not that nothing shipped", () => {
  const status: ProductStatus = { deploy: { kind: "refused" }, entry: "index.html" };

  expect(productStateOf(status)).toBe("vercel refused: reconnect");
  expect(deploymentOf(status)).toBeNull();
});

it("reads a ready deploy as live and anything else by its state", () => {
  expect(productStateOf({ deploy: { deployment, kind: "deployed" }, entry: null })).toBe("LIVE");
  expect(
    productStateOf({
      deploy: { deployment: { ...deployment, state: "BUILDING" }, kind: "deployed" },
      entry: null,
    }),
  ).toBe("building");
});

it("falls back to the entry when nothing is deployed or nothing is bound", () => {
  expect(productStateOf({ deploy: { kind: "none" }, entry: "index.html" })).toBe("local build");
  expect(productStateOf({ deploy: null, entry: null })).toBe("unshipped");
});
