import type { ProductStatus, VercelDeployment } from "@/shared/integrations";

export const deploymentOf = (status: ProductStatus | undefined): VercelDeployment | null =>
  status?.deploy?.kind === "deployed" ? status.deploy.deployment : null;

export const productStateOf = (status: ProductStatus | undefined): string => {
  if (status?.deploy?.kind === "refused") {
    return "vercel refused: reconnect";
  }
  const deploy = deploymentOf(status);
  if (deploy) {
    return deploy.state === "READY" ? "LIVE" : deploy.state.toLowerCase();
  }
  return status?.entry ? "local build" : "unshipped";
};
