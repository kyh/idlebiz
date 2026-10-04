// The founder's Vercel: the token, and which project each product deploys to.

import { oc, type } from "@orpc/contract";
import type { VercelListing } from "@repo/domain/integrations";
import type { Done } from "../done";
import { connectInput, disconnectInput, projectsInput, saveTokenInput } from "./vercel-schema";

export const vercelContract = {
  /** Binds a product to a project of the founder's. */
  connect: oc.input(connectInput).output(type<Done>()),
  disconnect: oc.input(disconnectInput).output(type<Done>()),
  projects: oc.input(projectsInput).output(type<VercelListing>()),
  saveToken: oc.input(saveTokenInput).output(type<Done>()),
};
