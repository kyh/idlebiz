import type { ProductStatus } from "@/shared/ipc-registry";

export const productStateOf = (status: ProductStatus | undefined): string => {
  const deploy = status?.deploy ?? null;
  if (deploy) {
    return deploy.state === "READY" ? "LIVE" : deploy.state.toLowerCase();
  }
  return status?.entry ? "local build" : "unshipped";
};
