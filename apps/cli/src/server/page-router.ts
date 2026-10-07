// The page's API, implemented: every procedure of the contract (@repo/contract/contract), each a
// line onto the store, the scheduler or the integrations. `os.router` is the completeness check: a
// handler drifting from its contract, or a procedure nobody implemented, fails to compile here. One
// middleware words every answer that does not return (lib/answers.ts), the input's validation
// included, so the page shows the store's own sentence.

import { implement } from "@orpc/server";
import { contract } from "@repo/contract/contract";
import { isOutOfBudget, spriteSeedFor } from "@repo/domain/domain";
import type { IntegrationNeed } from "@repo/domain/domain";
import { agentDriver } from "./agents/agent-driver";
import { generateCandidates, startLogin } from "./agents/onboarding";
import { notingSeal } from "./agents/seal";
import {
  haltForBudget,
  killBet,
  retireProduct,
  setAutopilot,
  startProduct,
} from "./company-actions";
import { host } from "./host";
import { answerOf } from "./lib/answers";
import { broadcast } from "./lib/broadcast";
import { launchAtLogin, setLaunchAtLogin } from "./login-item";
import { metricsPulse } from "./metrics-pulse";
import { ROOT_DIR } from "./paths";
import { printfulTokenStatus, removePrintfulToken, savePrintfulToken } from "./printful-token";
import { openProduct, openWorkspacePath, productStatus } from "./product";
import { chatOptions } from "./prompts/chat-options";
import type { createScheduler } from "./scheduler";
import * as store from "./store/store";
import { beginConnect, disconnectStripe, getStripeStatus } from "./stripe-connect";
import { removeStripeKey, saveStripeKey, stripeKeyStatus } from "./stripe-key";
import {
  connectVercel,
  disconnectVercel,
  listVercelProjects,
  saveVercelToken,
} from "./vercel-connect";

/** What the router acts through that only the server's boot makes. */
export interface PageRouterDeps {
  scheduler: ReturnType<typeof createScheduler>;
  /** Deletes the save, then starts the app again. */
  resetGame: () => Promise<void>;
  /** An integration that reads revenue is ready: read it now, and resume what waited on it. */
  stripeReady: (...needs: IntegrationNeed[]) => void;
}

const os = implement(contract).use(async ({ next, path }) => {
  try {
    return await next();
  } catch (error) {
    throw answerOf(error, path.join("."));
  }
});

export const createPageRouter = ({ resetGame, scheduler, stripeReady }: PageRouterDeps) =>
  os.router({
    agents: {
      hasAuth: os.agents.hasAuth.handler(async () => ({
        ok: await agentDriver.hasAnyRunner(),
        signedOut: await agentDriver.signedOut(),
      })),
      resting: os.agents.resting.handler(() => agentDriver.restingRunners()),
      startLogin: os.agents.startLogin.handler(() => {
        void startLogin(agentDriver, (e) => {
          broadcast("auth", e);
        });
        return { started: true };
      }),
    },
    app: {
      // the window is refused every permission, the clipboard's included: the shell writes it
      copyText: os.app.copyText.handler(async ({ input }) => {
        await host().copyText(input.text);
      }),
      launchAtLogin: os.app.launchAtLogin.handler(() => launchAtLogin()),
      setLaunchAtLogin: os.app.setLaunchAtLogin.handler(({ input }) => setLaunchAtLogin(input.on)),
    },
    bets: {
      kill: os.bets.kill.handler(({ input }) => killBet(input.betId, input.reason)),
      list: os.bets.list.handler(() => store.listBets()),
    },
    characters: {
      compose: os.characters.compose.handler(async ({ input }) => {
        const { composeCharacter } = await import("./character/compositor");
        return await composeCharacter(input.seed);
      }),
      founders: os.characters.founders.handler(async () => {
        const { listFounderChoices } = await import("./character/compositor");
        return await listFounderChoices(6);
      }),
    },
    company: {
      get: os.company.get.handler(() => store.getCompany()),
      openPath: os.company.openPath.handler(({ input }) => openWorkspacePath(input.rel)),
      resetSpend: os.company.resetSpend.handler(() => store.resetSpend()),
      setAutopilot: os.company.setAutopilot.handler(({ input }) => setAutopilot(input.running)),
      setBudget: os.company.setBudget.handler(({ input }) => {
        const company = store.setBudget(input.budget);
        if (isOutOfBudget(company)) {
          haltForBudget(company);
        }
        return store.requireCompany();
      }),
      setMaxAgents: os.company.setMaxAgents.handler(({ input }) =>
        store.setMaxAgents(input.maxAgents),
      ),
      takeDigest: os.company.takeDigest.handler(() => store.takeDigest()),
    },
    employees: {
      direct: os.employees.direct.handler(({ input }) =>
        scheduler.directEmployee(input.employeeId, input.instruction.trim()),
      ),
      list: os.employees.list.handler(() => store.listEmployees()),
      options: os.employees.options.handler(({ input }) => {
        const emp = store.getEmployee(input.employeeId);
        if (!emp) {
          throw new Error(`no employee ${input.employeeId}`);
        }
        return chatOptions(emp, store.openTasksFor(input.employeeId));
      }),
    },
    onboarding: {
      // one call, whole or not at all: the roster's CLIs are chosen first, so a machine with
      // nothing signed in fails before a folder exists
      found: os.onboarding.found.handler(({ input: { hires, ...company } }) =>
        store.foundCompany({
          ...company,
          hires: hires.map((hire, i) => ({ runner: agentDriver.pickRunner(i), ...hire })),
        }),
      ),
      hires: os.onboarding.hires.handler(async ({ input }) => {
        const candidates = await generateCandidates(input);
        return candidates.map((candidate, i) =>
          Object.assign(candidate, {
            spriteSeed: spriteSeedFor(candidate.role, candidate.name, `-${i}`),
          }),
        );
      }),
    },
    printful: {
      removeToken: os.printful.removeToken.handler(() => removePrintfulToken()),
      saveToken: os.printful.saveToken.handler(async ({ input }) => {
        await savePrintfulToken(input.token);
        scheduler.resumeIntegrationAsks("printful");
      }),
      tokenStatus: os.printful.tokenStatus.handler(() => printfulTokenStatus()),
    },
    products: {
      create: os.products.create.handler(({ input }) => startProduct(input, null)),
      kill: os.products.kill.handler(({ input }) =>
        retireProduct(input.productId, input.reason, null),
      ),
      list: os.products.list.handler(() => store.listProducts()),
      open: os.products.open.handler(async ({ input }) => ({
        opened: await openProduct(input.productId),
      })),
      status: os.products.status.handler(({ input }) => productStatus(input.productId)),
    },
    save: {
      openFolder: os.save.openFolder.handler(async () => {
        await host().open({ kind: "path", target: ROOT_DIR });
      }),
      // the first report waits on the seal's check, so a refusal is in it
      report: os.save.report.handler(async () => {
        const refusal = await agentDriver.sealRefusal();
        return notingSeal(store.loadReport(), refusal);
      }),
      reset: os.save.reset.handler(() => resetGame()),
    },
    stripe: {
      connect: os.stripe.connect.handler(() => beginConnect(store.requireCompany().id)),
      disconnect: os.stripe.disconnect.handler(() => disconnectStripe(store.requireCompany().id)),
      keyStatus: os.stripe.keyStatus.handler(() => stripeKeyStatus()),
      removeKey: os.stripe.removeKey.handler(() => {
        removeStripeKey();
        metricsPulse.now();
      }),
      saveKey: os.stripe.saveKey.handler(async ({ input }) => {
        await saveStripeKey(input.key);
        stripeReady("stripe", "stripe-key");
      }),
      status: os.stripe.status.handler(() => {
        const company = store.getCompany();
        return company ? getStripeStatus(company.id) : { state: "disconnected" };
      }),
    },
    tasks: {
      answer: os.tasks.answer.handler(({ input }) =>
        scheduler.answerQuestion(input.taskId, input.answer),
      ),
      assign: os.tasks.assign.handler(({ input }) =>
        scheduler.assign(input.taskId, input.employeeId),
      ),
      list: os.tasks.list.handler(({ input }) => store.queryTasks(input)),
      resolveAction: os.tasks.resolveAction.handler(({ input }) =>
        scheduler.resolveAction(input.taskId, input.reply),
      ),
      resolveApproval: os.tasks.resolveApproval.handler(({ input }) =>
        scheduler.resolveApproval(input.taskId, input.approved),
      ),
      shipped: os.tasks.shipped.handler(() => store.shippingLog()),
    },
    team: {
      messages: os.team.messages.handler(({ input }) =>
        store.recentTeamMessages(input.limit ?? 30),
      ),
      post: os.team.post.handler(({ input }) => scheduler.founderMessage(input.text.trim())),
    },
    vercel: {
      connect: os.vercel.connect.handler(({ input }) => connectVercel(input)),
      disconnect: os.vercel.disconnect.handler(({ input }) => disconnectVercel(input.productId)),
      projects: os.vercel.projects.handler(({ input }) => listVercelProjects(input.token)),
      saveToken: os.vercel.saveToken.handler(({ input }) => saveVercelToken(input)),
    },
  });
