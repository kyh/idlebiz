// Both ends ship in one app, so the page's API may break freely: nothing here is versioned.

import { asyncIteratorObject, oc } from "@orpc/contract";
import { agentsContract } from "./agents-contract";
import { appContract } from "./app-contract";
import { betsContract } from "./bets-contract";
import { companyContract } from "./company-contract";
import { employeesContract } from "./employees-contract";
import { PageEventSchema } from "./events";
import { onboardingContract } from "./onboarding-contract";
import { printfulContract } from "./printful-contract";
import { productsContract } from "./products-contract";
import { saveContract } from "./save-contract";
import { stripeContract } from "./stripe-contract";
import { tasksContract } from "./tasks-contract";
import { teamContract } from "./team-contract";
import { vercelContract } from "./vercel-contract";

export const contract = {
  agents: agentsContract,
  app: appContract,
  bets: betsContract,
  company: companyContract,
  employees: employeesContract,
  /** The server's events as they happen, until the page lets go: each checked as it is sent. */
  events: oc.output(asyncIteratorObject(PageEventSchema)),
  onboarding: onboardingContract,
  printful: printfulContract,
  products: productsContract,
  save: saveContract,
  stripe: stripeContract,
  tasks: tasksContract,
  team: teamContract,
  vercel: vercelContract,
};

export type Contract = typeof contract;
