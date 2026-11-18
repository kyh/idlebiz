import type { ProductStatus } from "@repo/domain/integrations";

export const deploymentOf = (status: ProductStatus | undefined) =>
  status?.deploy?.kind === "deployed" ? status.deploy.deployment : null;

export const productStateOf = (status: ProductStatus | undefined) => {
  if (status?.deploy?.kind === "refused") {
    return "vercel refused: reconnect";
  }

  const deploy = deploymentOf(status);

  if (deploy) {
    return deploy.state === "READY" ? "LIVE" : deploy.state.toLowerCase();
  }

  return status?.entry ? "local build" : "unshipped";
};
