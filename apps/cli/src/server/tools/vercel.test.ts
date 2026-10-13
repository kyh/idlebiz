import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BadRequestError } from "@repo/domain/errors";
import type { DeployRequest } from "../deploy";
import type { EnvRequest, EnvResult } from "../vercel-env";
import type { RunContext } from "./define";
import {
  BOUND_ACTION,
  DEPLOYED,
  TOKEN,
  VERCEL,
  callTool,
  connectVercel,
  deployingRun,
  runAs,
} from "../test-support/tools";
import { freshSave } from "../test-support/save";
import * as store from "../store/store";
import { callTool as outcomeOf } from "./index";

const root = freshSave();

const NEW_ACTION = "deploy acme to production on a new Vercel project named acme";
const NEW_PROJECT = { projectId: "prj_new", projectName: "acme", teamId: null };

describe("deploy", () => {
  it("holds the first call for the founder's sign-off on the product and the project it lands in", async () => {
    connectVercel(root);
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    store.setProductVercel("acme", VERCEL);
    expect(await outcomeOf(ctx, "deploy", {})).toEqual({
      kind: "held",
      text: `Held for the founder's sign-off on "${BOUND_ACTION}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    });
    expect(asked).toEqual([{ command: BOUND_ACTION, rule: "deploy", type: "approval" }]);
    expect(deploys).toEqual([]);
  });

  it("deploys once signed off, into the product's project, and spends the sign-off", async () => {
    connectVercel(root);
    const { ctx, deploys } = deployingRun(DEPLOYED);
    const product = store.setProductVercel("acme", VERCEL);
    store.grantApproval(ctx.run.taskId, BOUND_ACTION);

    expect(await callTool(ctx, "deploy", {})).toBe(
      "Deployed Acme to production: https://acme-1.vercel.app",
    );
    expect(deploys).toEqual([
      {
        cwd: product.workspaceDir,
        target: { binding: VERCEL, kind: "bound" },
        token: TOKEN,
        unshippable: [{ kind: "held", name: "VERCEL_TOKEN", value: TOKEN }],
      },
    ]);
    expect(await callTool(ctx, "deploy", {})).toContain("Held for the founder's sign-off");
    expect(deploys).toHaveLength(1);
  });

  it("leads with the production domain, since the deployment's own URL sits behind Vercel's login", async () => {
    connectVercel(root);
    const { ctx } = deployingRun({ ...DEPLOYED, alias: "https://acme.vercel.app" });
    store.setProductVercel("acme", VERCEL);
    store.grantApproval(ctx.run.taskId, BOUND_ACTION);

    expect(await callTool(ctx, "deploy", {})).toBe(
      "Deployed Acme to production: https://acme.vercel.app (this deployment: https://acme-1.vercel.app)",
    );
  });

  it("puts a product bound to nothing into a project named for it, and binds it there", async () => {
    connectVercel(root);
    const { ctx, asked, deploys } = deployingRun({ ...DEPLOYED, project: NEW_PROJECT });
    expect(await callTool(ctx, "deploy", {})).toContain(`sign-off on "${NEW_ACTION}"`);
    expect(asked).toEqual([{ command: NEW_ACTION, rule: "deploy", type: "approval" }]);
    store.grantApproval(ctx.run.taskId, NEW_ACTION);

    expect(await callTool(ctx, "deploy", {})).toBe(
      "Deployed Acme to production: https://acme-1.vercel.app\nAcme is now bound to the new Vercel project acme, which counts its visitors.",
    );
    expect(deploys.map((d) => d.target)).toEqual([{ kind: "new", name: "acme" }]);
    expect(store.getProduct("acme")?.vercel).toEqual(NEW_PROJECT);
  });

  it("binds a new project its failed deploy made, so the next deploy lands there too", async () => {
    connectVercel(root);
    const reason = 'Vercel\'s build failed: Command "npm run build" exited with 1.';
    const { ctx } = deployingRun({ kind: "failed", project: NEW_PROJECT, reason });
    store.grantApproval(ctx.run.taskId, NEW_ACTION);

    expect(await callTool(ctx, "deploy", {})).toBe(
      `The deploy of Acme failed: ${reason}\nAcme is now bound to the new Vercel project acme, which counts its visitors.`,
    );
    expect(store.getProduct("acme")?.vercel).toEqual(NEW_PROJECT);
  });

  it("leaves a binding the founder made while the deploy ran", async () => {
    connectVercel(root);
    const run = deployingRun(DEPLOYED);
    const ctx: RunContext = {
      ...run.ctx,
      deploy: () => {
        store.setProductVercel("acme", VERCEL);
        return Promise.resolve({ ...DEPLOYED, project: NEW_PROJECT });
      },
    };
    store.grantApproval(ctx.run.taskId, NEW_ACTION);

    expect(await callTool(ctx, "deploy", {})).toBe(
      "Deployed Acme to production: https://acme-1.vercel.app",
    );
    expect(store.getProduct("acme")?.vercel).toEqual(VERCEL);
  });

  it("asks the founder to bind a product whose name another Vercel project holds", async () => {
    connectVercel(root);
    const { ctx, asked } = deployingRun({ kind: "name-taken", name: "acme" });
    store.grantApproval(ctx.run.taskId, NEW_ACTION);

    expect(await callTool(ctx, "deploy", {})).toContain(
      'Vercel already has a project named "acme"',
    );
    expect(asked).toEqual([
      {
        integration: "vercel",
        productId: "acme",
        reason: 'to bind Acme to its Vercel project: one named "acme" already exists',
        type: "integration",
      },
    ]);
    expect(store.getProduct("acme")?.vercel).toBeNull();
  });

  it("deploys only its run's own product, the folder a signed run has to itself", async () => {
    connectVercel(root);
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    const side = store.createProduct({ description: "a side project", name: "Side" });
    store.grantApproval(
      ctx.run.taskId,
      `deploy ${side.id} to production on a new Vercel project named ${side.id}`,
    );

    await expect(callTool(ctx, "deploy", { product: side.id })).rejects.toThrow(
      'Unrecognized key: "product"',
    );
    expect(asked).toEqual([]);
    expect(deploys).toEqual([]);
  });

  it("deploys nothing from a run on no product", async () => {
    connectVercel(root);
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    const companyRun: RunContext = { ...ctx, run: { ...ctx.run, productId: null } };
    store.grantApproval(ctx.run.taskId, BOUND_ACTION);
    store.setProductVercel("acme", VERCEL);

    expect(await callTool(companyRun, "deploy", {})).toBe(
      "Your run is on no product, so it has no folder to deploy: a deploy ships the folder of the run's own product, which that run builds and checks right before the call. Hand the deploy to a teammate on the product with delegate.",
    );
    expect(asked).toEqual([]);
    expect(deploys).toEqual([]);
  });

  it("refuses a folder holding a key set_env set before the founder is asked to sign off", async () => {
    connectVercel(root);
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    const product = store.setProductVercel("acme", VERCEL);
    const key = "sk-proj-acme-runtime";
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({
        [`ENV/${product.id}/${VERCEL.projectId}/OPENAI_API_KEY`]: key,
        VERCEL_TOKEN: TOKEN,
      }),
    );
    writeFileSync(path.join(product.workspaceDir, "ai.js"), `const key = "${key}";`);

    expect(await callTool(ctx, "deploy", {})).toBe(
      "Nothing was deployed: ai.js holds the value set_env set as OPENAI_API_KEY on acme, and a deploy would publish it. Take it out of the folder, read it from process.env.OPENAI_API_KEY instead, then deploy again.",
    );
    expect(asked).toEqual([]);
    expect(deploys).toEqual([]);
  });

  it("refuses a folder holding a key IdleBiz itself uses, before the founder is asked", async () => {
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    const product = store.setProductVercel("acme", VERCEL);
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ STRIPE_SECRET_KEY: "sk_live_founders_own", VERCEL_TOKEN: TOKEN }),
    );
    writeFileSync(path.join(product.workspaceDir, "pay.js"), 'const key = "sk_live_founders_own";');

    const answer = await callTool(ctx, "deploy", {});

    expect(answer).toContain("pay.js holds IdleBiz's own STRIPE_SECRET_KEY");
    expect(answer).not.toContain("sk_live_founders_own");
    expect(asked).toEqual([]);
    expect(deploys).toEqual([]);
  });

  it("asks for Vercel, not a sign-off, while no key is saved", async () => {
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    expect(await callTool(ctx, "deploy", {})).toContain("Vercel is not connected");
    expect(asked).toEqual([
      { integration: "vercel", productId: "acme", reason: "to deploy Acme", type: "integration" },
    ]);
    expect(deploys).toEqual([]);
  });
  it("asks for Vercel anew, and spends no sign-off, while Vercel turns the saved token away", async () => {
    connectVercel(root);
    const run = deployingRun(DEPLOYED);
    store.setProductVercel("acme", VERCEL);
    store.grantApproval(run.ctx.run.taskId, BOUND_ACTION);
    const checked: string[] = [];
    const ctx: RunContext = {
      ...run.ctx,
      checkVercelToken: (token) => {
        checked.push(token);
        return Promise.resolve({ kind: "rejected" });
      },
    };

    expect(await callTool(ctx, "deploy", {})).toContain(
      "Vercel turned IdleBiz's token away: the founder has a Vercel card waiting",
    );
    expect(checked).toEqual([TOKEN]);
    expect(run.asked).toEqual([
      {
        integration: "vercel",
        productId: "acme",
        reason: "Vercel turned IdleBiz's token away while deploying Acme",
        type: "integration",
      },
    ]);
    expect(run.deploys).toEqual([]);
    expect(await callTool(run.ctx, "deploy", {})).toBe(
      "Deployed Acme to production: https://acme-1.vercel.app",
    );
  });

  it("spends no sign-off while Vercel cannot be asked about the token", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    connectVercel(root);
    const run = deployingRun(DEPLOYED);
    store.setProductVercel("acme", VERCEL);
    store.grantApproval(run.ctx.run.taskId, BOUND_ACTION);
    const ctx: RunContext = {
      ...run.ctx,
      checkVercelToken: () => Promise.reject(new TypeError("fetch failed")),
    };

    expect(await callTool(ctx, "deploy", {})).toBe(
      "Vercel could not be asked whether IdleBiz's token still works (fetch failed); try again.",
    );
    expect(run.asked).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
    expect(await callTool(run.ctx, "deploy", {})).toContain("Deployed Acme");
  });
});

const OPENAI = { name: "OPENAI_API_KEY", value: "sk-proj-acme-runtime" };

const SET: EnvResult = { ok: true };

/** A run of Priya's on Acme whose variables answer `result`, and what each was asked. */
const settingRun = (result: EnvResult = SET) => {
  const run = runAs("priya");
  const sets: EnvRequest[] = [];
  const ctx: RunContext = {
    ...run.ctx,
    checkVercelToken: () => Promise.resolve({ account: "kai", kind: "valid" }),
    run: { ...run.ctx.run, productId: "acme" },
    setEnv: (req) => {
      sets.push(req);
      return Promise.resolve(result);
    },
  };
  return { ...run, ctx, sets };
};

describe("set_env", () => {
  it("refuses to set a key IdleBiz itself uses, naming only the key", async () => {
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ STRIPE_SECRET_KEY: "sk_live_founders_own", VERCEL_TOKEN: TOKEN }),
    );
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    const answer = await callTool(ctx, "set_env", {
      name: "STRIPE_KEY",
      value: "sk_live_founders_own",
    });

    expect(answer).toContain("that value is IdleBiz's own STRIPE_SECRET_KEY");
    expect(answer).not.toContain("sk_live_founders_own");
    expect(sets).toEqual([]);
  });

  it.each(["sk_live_foundersUnrestricted1", "sk_test_foundersUnrestricted1"])(
    "refuses a Stripe secret key IdleBiz does not hold: %s",
    async (value) => {
      connectVercel(root);
      const { ctx, sets } = settingRun();
      store.setProductVercel("acme", VERCEL);

      const answer = await callTool(ctx, "set_env", { name: "STRIPE_KEY", value });

      expect(answer).toBe(
        "STRIPE_KEY was not set: that value is a Stripe secret key (sk_), which can charge, refund and pay out on the founder's whole account, and no product holds one. Charging is create_payment_link's; a product that reads Stripe itself gets a restricted key (rk_) from the founder, granted only what it reads (see \"Checking who paid\").",
      );
      expect(answer).not.toContain(value);
      expect(sets).toEqual([]);
    },
  );

  it("sets a restricted Stripe key the founder made for the product", async () => {
    connectVercel(root);
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    expect(
      await callTool(ctx, "set_env", {
        name: "STRIPE_CHECKOUT_READ_KEY",
        value: "rk_live_checkoutReadOnly1",
      }),
    ).toContain("Set STRIPE_CHECKOUT_READ_KEY on Acme's Vercel project");
    expect(sets.map(({ value }) => value)).toEqual(["rk_live_checkoutReadOnly1"]);
  });

  it("sets a publishable key under a public name, and lets a deploy ship a file holding it", async () => {
    connectVercel(root);
    const { ctx, sets } = settingRun();
    const product = store.setProductVercel("acme", VERCEL);
    const publishable = "pk_live_acmePublishable1";

    expect(
      await callTool(ctx, "set_env", {
        name: "NEXT_PUBLIC_STRIPE_KEY",
        value: publishable,
      }),
    ).toBe(
      "Set NEXT_PUBLIC_STRIPE_KEY on Acme's Vercel project acme-site, for production and preview. It takes effect on the next deploy, built into the page for every visitor to read only by a framework that reads the NEXT_PUBLIC_ prefix: Next.js as process.env.NEXT_PUBLIC_…, Vite as import.meta.env.VITE_…, SvelteKit and Astro a PUBLIC_ name. Under any other framework it stays server-only, read as process.env.NEXT_PUBLIC_STRIPE_KEY, and no deploy refuses a file that holds it.",
    );
    expect(sets.map(({ name }) => name)).toEqual(["NEXT_PUBLIC_STRIPE_KEY"]);

    writeFileSync(path.join(product.workspaceDir, "pay.js"), `const pk = "${publishable}";`);
    const deploys: DeployRequest[] = [];
    const deploying: RunContext = {
      ...ctx,
      deploy: (req) => {
        deploys.push(req);
        return Promise.resolve(DEPLOYED);
      },
    };
    store.grantApproval(ctx.run.taskId, BOUND_ACTION);

    expect(await callTool(deploying, "deploy", {})).toContain("Deployed Acme");
    expect(deploys[0]?.unshippable).toEqual([{ kind: "held", name: "VERCEL_TOKEN", value: TOKEN }]);
  });

  it("refuses a secret under a public name, pointing at a server-only one", async () => {
    connectVercel(root);
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    const answer = await callTool(ctx, "set_env", {
      name: "VITE_STRIPE_KEY",
      value: "rk_live_checkoutReadOnly1",
    });

    expect(answer).toBe(
      "VITE_STRIPE_KEY was not set: that value looks like a Stripe secret or restricted key, and a VITE_ name is built into the page, where every visitor reads it. Set it under a server-only name, one without that prefix, which only server code reads as process.env.NAME; a public name is only for what any visitor may see, such as a Stripe publishable key (pk_).",
    );
    expect(sets).toEqual([]);
    expect(store.recentTeamMessages()).toEqual([]);
  });

  it("answers a Stripe secret key under a public name as the secret key it is", async () => {
    connectVercel(root);
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    expect(
      await callTool(ctx, "set_env", {
        name: "NEXT_PUBLIC_STRIPE_KEY",
        value: "sk_live_foundersUnrestricted1",
      }),
    ).toContain("that value is a Stripe secret key (sk_)");
    expect(sets).toEqual([]);
  });

  it.each(["opaqueServerOnly1234", "Bearer opaqueServerOnly1234", "ServerOnly1234"])(
    "refuses a public name over a value kept under a server-only one: %s",
    async (value) => {
      connectVercel(root);
      const { ctx, sets } = settingRun();
      store.setProductVercel("acme", VERCEL);
      await callTool(ctx, "set_env", { name: "DB_KEY", value: "opaqueServerOnly1234" });

      const answer = await callTool(ctx, "set_env", { name: "NEXT_PUBLIC_DB_KEY", value });

      expect(answer).toBe(
        "NEXT_PUBLIC_DB_KEY was not set: that value is the one set_env keeps as DB_KEY on acme, server-only, and a NEXT_PUBLIC_ name would build it into the page, where every visitor reads it. Server code reads it as process.env.DB_KEY; a public name is only for what any visitor may see, such as a Stripe publishable key (pk_).",
      );
      expect(answer).not.toContain(value);
      expect(sets.map(({ name }) => name)).toEqual(["DB_KEY"]);
      expect(store.recentTeamMessages().map(({ text }) => text)).toEqual(["🔑 set DB_KEY on Acme"]);
    },
  );

  it("sets the variable on the run's product's project with the founder's token, unsigned, and says when it takes effect", async () => {
    connectVercel(root);
    const { ctx, asked, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    const answer = await callTool(ctx, "set_env", OPENAI);
    expect(answer).toBe(
      "Set OPENAI_API_KEY on Acme's Vercel project acme-site, for production and preview. It takes effect on the next deploy; server code reads it as process.env.OPENAI_API_KEY. Never write its value into a file: deploy refuses a folder that holds it.",
    );
    expect(sets).toEqual([
      {
        binding: VERCEL,
        name: "OPENAI_API_KEY",
        replaces: false,
        token: TOKEN,
        value: OPENAI.value,
      },
    ]);
    expect(asked).toEqual([]);
    expect(store.recentTeamMessages().map(({ text }) => text)).toEqual([
      "🔑 set OPENAI_API_KEY on Acme",
    ]);
  });

  it("keeps the value in secrets.json, out of the save, and hands it to the next deploy to refuse", async () => {
    connectVercel(root);
    const { ctx } = settingRun();
    store.setProductVercel("acme", VERCEL);
    await callTool(ctx, "set_env", OPENAI);
    const deploys: DeployRequest[] = [];
    const deploying: RunContext = {
      ...ctx,
      deploy: (req) => {
        deploys.push(req);
        return Promise.resolve(DEPLOYED);
      },
    };
    store.grantApproval(ctx.run.taskId, BOUND_ACTION);

    await callTool(deploying, "deploy", {});
    expect(deploys[0]?.unshippable).toEqual([
      { ...OPENAI, kind: "env", product: "acme" },
      { kind: "held", name: "VERCEL_TOKEN", value: TOKEN },
    ]);
    const saved = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name !== "secrets.json",
    );
    expect(saved.length).toBeGreaterThan(0);
    for (const entry of saved) {
      expect(readFileSync(path.join(entry.parentPath, entry.name), "utf-8")).not.toContain(
        OPENAI.value,
      );
    }
  });

  it("replaces only a name the team set, and keeps nothing Vercel turned down", async () => {
    connectVercel(root);
    const refused = settingRun({
      error: "Vercel turned it down (403): A variable with this name already exists",
      ok: false,
    });
    store.setProductVercel("acme", VERCEL);

    expect(await callTool(refused.ctx, "set_env", OPENAI)).toBe(
      "OPENAI_API_KEY was not set on Acme: Vercel turned it down (403): A variable with this name already exists\nset_env only replaces a variable the team set: if acme-site already has OPENAI_API_KEY, it is the founder's, so hand them an ask_boss action to change it.",
    );
    expect(store.recentTeamMessages()).toEqual([]);

    const sets: EnvRequest[] = [];
    const ctx: RunContext = {
      ...refused.ctx,
      setEnv: (req) => {
        sets.push(req);
        return Promise.resolve(SET);
      },
    };
    await callTool(ctx, "set_env", OPENAI);
    await callTool(ctx, "set_env", { ...OPENAI, value: "sk-proj-acme-rotated" });
    expect([...refused.sets, ...sets].map((req) => req.replaces)).toEqual([false, false, true]);
  });

  it("replaces a name only on the project the team set it on, never on one the product is rebound to", async () => {
    connectVercel(root);
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);
    await callTool(ctx, "set_env", OPENAI);

    const founders = { projectId: "prj_live", projectName: "founder-live", teamId: null };
    store.setProductVercel("acme", founders);
    await callTool(ctx, "set_env", { ...OPENAI, value: "sk-proj-acme-rotated" });
    store.setProductVercel("acme", VERCEL);
    await callTool(ctx, "set_env", { ...OPENAI, value: "sk-proj-acme-rotated" });

    expect(sets.map(({ binding, replaces }) => [binding.projectId, replaces])).toEqual([
      ["prj_1", false],
      ["prj_live", false],
      ["prj_1", true],
    ]);
  });

  it("sends the value without the whitespace a paste carries", async () => {
    connectVercel(root);
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    await callTool(ctx, "set_env", { ...OPENAI, value: ` ${OPENAI.value}\n` });
    expect(sets[0]?.value).toBe(OPENAI.value);
  });

  it("tells a run whose product has no project yet to deploy first", async () => {
    connectVercel(root);
    const { ctx, sets } = settingRun();

    expect(await callTool(ctx, "set_env", OPENAI)).toBe(
      "Acme has no Vercel project yet: deploy it first, which makes one, then set OPENAI_API_KEY.",
    );
    expect(sets).toEqual([]);
  });

  it("asks for Vercel while no key is saved", async () => {
    const { ctx, asked, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    expect(await callTool(ctx, "set_env", OPENAI)).toContain("Vercel is not connected");
    expect(asked).toEqual([
      {
        integration: "vercel",
        productId: "acme",
        reason: "to set OPENAI_API_KEY on Acme",
        type: "integration",
      },
    ]);
    expect(sets).toEqual([]);
  });

  it("asks for Vercel anew while Vercel turns the saved token away", async () => {
    connectVercel(root);
    const run = settingRun();
    store.setProductVercel("acme", VERCEL);
    const ctx: RunContext = {
      ...run.ctx,
      checkVercelToken: () => Promise.resolve({ kind: "rejected" }),
    };

    expect(await callTool(ctx, "set_env", OPENAI)).toContain(
      "Vercel turned IdleBiz's token away: the founder has a Vercel card waiting",
    );
    expect(run.asked).toEqual([
      {
        integration: "vercel",
        productId: "acme",
        reason: "Vercel turned IdleBiz's token away while setting OPENAI_API_KEY on Acme",
        type: "integration",
      },
    ]);
    expect(run.sets).toEqual([]);
  });

  it("refuses a name Vercel keeps as the caller's error", async () => {
    connectVercel(root);
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    for (const name of ["VERCEL_URL", "NODE_ENV", "openai_key"]) {
      await expect(callTool(ctx, "set_env", { ...OPENAI, name })).rejects.toThrow(BadRequestError);
    }
    expect(sets).toEqual([]);
  });
});
