// The page's API: every call the window makes of the server, one folder per domain, each its
// contract and its inputs' schemas. The page compiles against it (apps/desktop/src/renderer/api.ts)
// and `idlebiz serve` implements it (apps/cli/src/server/page-router.ts), which fails to compile
// while a procedure is missing or mistyped. Both ends ship in one app, so it may break freely.

import { agentsContract } from "./agents/agents-contract";
import { appContract } from "./app/app-contract";
import { betsContract } from "./bets/bets-contract";
import { charactersContract } from "./characters/characters-contract";
import { companyContract } from "./company/company-contract";
import { employeesContract } from "./employees/employees-contract";
import { onboardingContract } from "./onboarding/onboarding-contract";
import { printfulContract } from "./printful/printful-contract";
import { productsContract } from "./products/products-contract";
import { saveContract } from "./save/save-contract";
import { stripeContract } from "./stripe/stripe-contract";
import { tasksContract } from "./tasks/tasks-contract";
import { teamContract } from "./team/team-contract";
import { vercelContract } from "./vercel/vercel-contract";

export const contract = {
  agents: agentsContract,
  app: appContract,
  bets: betsContract,
  characters: charactersContract,
  company: companyContract,
  employees: employeesContract,
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
