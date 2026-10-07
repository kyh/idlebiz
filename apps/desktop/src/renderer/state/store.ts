import { useSyncExternalStore } from "react";
import type { ActivityEvent } from "@repo/domain/activity";
import type { Bet } from "@repo/domain/bets";
import { taskIn } from "@repo/domain/domain";
import type {
  ActionReply,
  AgentRunner,
  AuthFlowEvent,
  Budget,
  Company,
  Employee,
  LoadSkip,
  Product,
  RestingRunners,
  Task,
  TaskIn,
  TeamMessage,
} from "@repo/domain/domain";
import type { Digest } from "@repo/domain/digest";
import { errorMessage } from "@repo/domain/errors";
import type { ProductStatus, StripeKeyStatus, StripeStatus } from "@repo/domain/integrations";
import { api, listen } from "@/renderer/api";
import { hear, tell } from "@/renderer/game/office-port";
import type { Office } from "@/renderer/game/office-port";
import { FEED_LINES, joinFeed, reduceActivity, roomLines } from "@/renderer/state/activity-reducer";
import type { FeedLine, Slice } from "@/renderer/state/activity-reducer";
import { bootOf } from "@/renderer/state/boot";
import type { Boot } from "@/renderer/state/boot";
import { Coalesced, latestWins } from "@/renderer/state/ordering";

interface State {
  /** The first refresh finished: company, roster and tasks are known (or known absent). */
  booted: boolean;
  /** Why the last refresh before boot failed; null once one lands. */
  bootFailure: string | null;
  /** A coding CLI is signed in, by main's probe or a login since; null until the probe answers. */
  authed: boolean | null;
  /** Runners not signed in, a login a turn found refused included: everyone on one waits on a sign-in. */
  signedOut: AgentRunner[];
  stripeStatus: StripeStatus;
  /** The key the team charges with; unset until main answers. */
  stripeKey: StripeKeyStatus;
  /** Everything the company builds, oldest first, and where each one really is. */
  products: Product[];
  productStatus: ReadonlyMap<string, ProductStatus>;
  /** Every bet the company has made, oldest first. */
  bets: Bet[];
  resting: RestingRunners;
  /** Packages boot could not read. A skipped company blocks the office (see Boot). */
  saveIssues: LoadSkip[];
  company: Company | null;
  employees: Employee[];
  activity: ActivityEvent[];
  /** What the #team channel shows, newest last: the room as each refresh reads it, and the news heard since the window opened. */
  feed: FeedLine[];
  /** Awaiting the founder's answer. */
  pendingAsks: TaskIn<"blocked">[];
  /** Dead-lettered, needing a retry. */
  stuckTasks: TaskIn<"dead">[];
  game: Office | null;
  /** A dialogue/modal overlay is up (ambient HUD chrome hides). */
  modalOpen: boolean;
  /** The employee the founder is talking to, from the office or the roster. */
  talkingTo: string | null;
}

let state: State = {
  activity: [],
  authed: null,
  bets: [],
  bootFailure: null,
  booted: false,
  company: null,
  employees: [],
  feed: [],
  game: null,
  modalOpen: false,
  pendingAsks: [],
  productStatus: new Map(),
  products: [],
  resting: {},
  saveIssues: [],
  signedOut: [],
  stripeKey: { state: "unset" },
  stripeStatus: { state: "disconnected" },
  stuckTasks: [],
  talkingTo: null,
};
const listeners = new Set<() => void>();

const set = (patch: Partial<State>): void => {
  state = { ...state, ...patch };
  for (const l of listeners) {
    l();
  }
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Subscribe to one value in the store. The component re-renders only when it
 * changes — so select a field, not a fresh object.
 */
export const useStore = <T>(selector: (s: State) => T): T => {
  const select = (): T => selector(state);
  return useSyncExternalStore(subscribe, select, select);
};

/** What the window shows, re-rendered only when one of its inputs moves. */
export const useBoot = (): Boot => {
  const saveIssues = useStore((s) => s.saveIssues);
  const booted = useStore((s) => s.booted);
  const bootFailure = useStore((s) => s.bootFailure);
  const hasCompany = useStore((s) => s.company !== null);
  const authed = useStore((s) => s.authed);
  return bootOf({ authed, bootFailure, booted, hasCompany, saveIssues });
};

// Scene startup can finish after an overlay mounted; replay the current keyboard state.
const syncModal = (): void => {
  if (state.game) {
    tell(state.game, "ui-modal", state.modalOpen);
  }
};

let stopHearingInputReady: (() => void) | null = null;

export const setGame = (game: Office | null): void => {
  stopHearingInputReady?.();
  set({ game });
  stopHearingInputReady = game ? hear(game, "office-input-ready", syncModal) : null;
  syncModal();
};

/** A company was just founded: the office rebuilds around its team. */
export const officeReady = (): void => {
  if (state.game) {
    tell(state.game, "company-ready", null);
  }
};

export const setTalkingTo = (employeeId: string | null): void => {
  set({ talkingTo: employeeId });
};

/** Toggle Phaser keyboard so typing in overlays doesn't move the player. */
export const setModalOpen = (open: boolean): void => {
  set({ modalOpen: open });
  syncModal();
};

/** Where each product really is: its entry and latest deploy (a lookup only for bound products). */
const loadProductStatus = async (
  products: readonly Product[],
): Promise<Map<string, ProductStatus>> => {
  const entries = await Promise.all(
    products.map(async (p) => {
      try {
        return [p.id, await api().products.status({ productId: p.id })] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
};

/** What a fetch can answer. Not `Slice`, which is what an event can move, "all" included. */
type Held = "company" | "employees" | "resting" | "tasks" | "bets" | "products" | "productStatus";

const order = latestWins<Held>();

/** Fetch one slice again, keeping the answer only if nothing newer has landed. */
const reloadSlice = async <T>(
  slice: Held,
  load: () => Promise<T>,
  apply: (value: T) => void,
): Promise<void> => {
  if (!state.company) {
    return;
  }
  const ticket = order.ticket();
  try {
    const value = await load();
    if (order.accepts(slice, ticket)) {
      apply(value);
    }
  } catch {
    // the next refresh catches up
  }
};

// Ticketed when the fan-out starts, which is only after its product list was
// accepted, so an older list's statuses never land over a newer one's.
const reloadProductStatus = (products: readonly Product[]): Promise<void> =>
  reloadSlice(
    "productStatus",
    () => loadProductStatus(products),
    (productStatus) => set({ productStatus }),
  );

const splitTasks = (tasks: readonly Task[]): Pick<State, "pendingAsks" | "stuckTasks"> => ({
  pendingAsks: tasks.filter(taskIn("blocked")),
  stuckTasks: tasks.filter(taskIn("dead")),
});

const refreshOnce = async (): Promise<void> => {
  const ticket = order.ticket();
  const [company, resting, load] = await Promise.all([
    api().company.get(),
    api().agents.resting(),
    api().save.report(),
  ]);
  const [employees, tasks, products, bets, room] = company
    ? await Promise.all([
        api().employees.list(),
        api().tasks.list({ status: ["blocked", "dead"] }),
        api().products.list(),
        api().bets.list(),
        api().team.messages({ limit: FEED_LINES }),
      ])
    : [[], [], [], [], []];
  // a slice a newer request or event already answered keeps the newer answer; the feed
  // keeps every line either way, so the room read back only adds what the window missed
  const patch: Partial<State> = {
    bootFailure: null,
    booted: true,
    feed: joinFeed(state.feed, roomLines(room)),
    saveIssues: load.skipped,
  };
  if (order.accepts("company", ticket)) {
    patch.company = company;
  }
  if (order.accepts("resting", ticket)) {
    patch.resting = resting;
  }
  if (order.accepts("employees", ticket)) {
    patch.employees = employees;
  }
  if (order.accepts("tasks", ticket)) {
    Object.assign(patch, splitTasks(tasks));
  }
  if (order.accepts("bets", ticket)) {
    patch.bets = bets;
  }
  const freshProducts = order.accepts("products", ticket);
  if (freshProducts) {
    patch.products = products;
  }
  set(patch);
  if (freshProducts) {
    void reloadProductStatus(products);
  }
};

const refreshing = new Coalesced(refreshOnce);

/** Ask main for everything again. Until one lands, a failure is what the window shows (see Boot). */
export const refresh = async (): Promise<void> => {
  try {
    await refreshing.call();
  } catch (error) {
    if (!state.booted) {
      set({ bootFailure: errorMessage(error) });
    }
    throw error;
  }
};

/** For a refresh nobody awaits: a failure is logged, and the next refresh catches up. */
const refreshInBackground = async (): Promise<void> => {
  try {
    await refresh();
  } catch (error) {
    console.error("Could not refresh", error);
  }
};

const reloadProducts = (): Promise<void> =>
  reloadSlice(
    "products",
    () => api().products.list(),
    (products) => {
      set({ products });
      void reloadProductStatus(products);
    },
  );

const reloadBets = (): Promise<void> =>
  reloadSlice(
    "bets",
    () => api().bets.list(),
    (bets) => set({ bets }),
  );

const reloadTasks = (): Promise<void> =>
  reloadSlice(
    "tasks",
    () => api().tasks.list({ status: ["blocked", "dead"] }),
    (tasks) => set(splitTasks(tasks)),
  );

const reloadCompany = (): Promise<void> =>
  reloadSlice(
    "company",
    () => api().company.get(),
    (company) => set({ company }),
  );

const reloadEmployees = (): Promise<void> =>
  reloadSlice(
    "employees",
    () => api().employees.list(),
    (employees) => set({ employees }),
  );

const reloadResting = (): Promise<void> =>
  reloadSlice(
    "resting",
    () => api().agents.resting(),
    (resting) => set({ resting }),
  );

// ---- actions ---------------------------------------------------------------

const withCompany = async (act: () => Promise<void>): Promise<void> => {
  if (state.company) {
    await act();
  }
};
// main answers a change with the company after it, newer than any read asked for before it
const updateCompany = (call: () => Promise<Company>): Promise<void> =>
  withCompany(async () => {
    const ticket = order.ticket();
    const company = await call();
    if (order.accepts("company", ticket)) {
      set({ company });
    }
  });

// main answers both with `bet.changed` / `product.killed`, and those events reload what moved
export const killBet = async (betId: string, reason: string): Promise<void> => {
  await api().bets.kill({ betId, reason });
};

export const killProduct = async (productId: string, reason: string): Promise<void> => {
  await api().products.kill({ productId, reason });
};

export const createProduct = (name: string, description: string): Promise<void> =>
  withCompany(async () => {
    await api().products.create({ description, name });
    await reloadProducts();
  });

export const teamMessages = async (limit = 30): Promise<TeamMessage[]> => {
  const c = state.company;
  return c ? await api().team.messages({ limit }) : [];
};

export const setAutopilot = (running: boolean): Promise<void> =>
  updateCompany(() => api().company.setAutopilot({ running }));

export const setBudget = (budget: Budget): Promise<void> =>
  updateCompany(() => api().company.setBudget({ budget }));

export const resetSpend = (): Promise<void> => updateCompany(() => api().company.resetSpend());

/** What happened since the founder last looked; asking is the look. */
export const digest = (): Promise<Digest | null> =>
  state.company ? api().company.takeDigest() : Promise.resolve(null);

export const setMaxAgents = (maxAgents: number): Promise<void> =>
  updateCompany(() => api().company.setMaxAgents({ maxAgents }));

export const connectStripe = (): Promise<void> =>
  withCompany(async () => {
    await api().stripe.connect();
  });

export const disconnectStripe = (): Promise<void> =>
  withCompany(async () => {
    await api().stripe.disconnect();
  });

const loadStripeKey = async (): Promise<void> => {
  set({ stripeKey: await api().stripe.keyStatus() });
};

export const saveStripeKey = async (key: string): Promise<void> => {
  await api().stripe.saveKey({ key });
  await loadStripeKey();
};

export const removeStripeKey = async (): Promise<void> => {
  await api().stripe.removeKey();
  await loadStripeKey();
};

export const connectVercel = async (input: {
  productId: string;
  /** Absent: keep the saved token. */
  token?: string;
  projectId: string;
  projectName: string;
  teamId?: string;
}): Promise<void> => {
  await api().vercel.connect(input);
  await reloadProducts();
};

export const disconnectVercel = async (productId: string): Promise<void> => {
  await api().vercel.disconnect({ productId });
  await reloadProducts();
};

export const directEmployee = async (employeeId: string, instruction: string): Promise<void> => {
  const text = instruction.trim();
  if (!text) {
    return;
  }
  await api().employees.direct({ employeeId, instruction: text });
};

/** Founder posts in the team channel; @first-name wakes that employee. */
export const sendFounderChat = (text: string): Promise<void> =>
  withCompany(async () => {
    if (text.trim()) {
      await api().team.post({ text: text.trim() });
    }
  });

/** Founder decides on a held outward-facing command; the task resumes either way. */
export const resolveApproval = async (taskId: string, approved: boolean): Promise<void> => {
  await api().tasks.resolveApproval({ approved, taskId });
};

/** Founder took, or could not take, a step only they could; the task resumes either way. */
export const resolveAction = async (taskId: string, reply: ActionReply): Promise<void> => {
  await api().tasks.resolveAction({ reply, taskId });
};

export const copyText = async (text: string): Promise<void> => {
  await api().app.copyText({ text });
};

/** Revive a dead-lettered / failed task: re-assign it (the claim resets retries). */
export const retryTask = async (task: Task): Promise<void> => {
  if (!task.assigneeId) {
    return;
  }
  await api().tasks.assign({ employeeId: task.assigneeId, taskId: task.id });
};

export const listTasksFor = async (employeeId: string): Promise<Task[]> => {
  const { company } = state;
  if (!company) {
    return [];
  }
  return await api().tasks.list({
    assigneeId: employeeId,
    status: ["queued", "running", "blocked"],
  });
};

export const answerQuestion = async (taskId: string, answer: string): Promise<void> => {
  await api().tasks.answer({ answer, taskId });
};

// ---- activity --------------------------------------------------------------

const RELOAD = {
  all: refreshInBackground,
  bets: reloadBets,
  company: reloadCompany,
  employees: reloadEmployees,
  products: reloadProducts,
  resting: reloadResting,
  tasks: reloadTasks,
} satisfies Record<Slice, () => Promise<void>>;

// The copy can lack a hire even after the refresh their event asked for: a
// patch that landed meanwhile refuses that refresh's roster.
const findHire = async (employeeId: string): Promise<Employee | undefined> => {
  const isHire = (emp: Employee): boolean => emp.id === employeeId;
  const held = state.employees.find(isHire);
  if (held) {
    return held;
  }
  try {
    const roster = await api().employees.list();
    return roster.find(isHire);
  } catch {
    // they appear in the office when it next boots
    return undefined;
  }
};

// Surgical: the one employee walks in or out, no scene rebuild.
const walkThroughDoor = async (roster: { employeeId: string; hired: boolean }): Promise<void> => {
  if (!state.game) {
    return;
  }
  if (!roster.hired) {
    tell(state.game, "despawn-employee", roster.employeeId);
    return;
  }
  const hire = await findHire(roster.employeeId);
  // the office may have been torn down while main answered
  const { game } = state;
  if (hire && game) {
    tell(game, "spawn-employee", hire);
  }
};

const loadAuth = async (): Promise<void> => {
  try {
    const r = await api().agents.hasAuth();
    set({ authed: r.ok, signedOut: r.signedOut });
  } catch (error) {
    // left unknown, the office would wait forever; the gate at least offers a sign-in
    console.error("Could not check the CLI login", error);
    set({ authed: false });
  }
};

const onActivity = async (e: ActivityEvent): Promise<void> => {
  const { patch, recheckAuth, reload, roster } = reduceActivity(state, e);
  // the event is newer than any answer still in flight, which must not undo it
  if (patch.employees) {
    order.patched("employees");
  }
  if (patch.resting) {
    order.patched("resting");
  }
  set(patch);
  // With no company in the copy yet no slice is fetched alone, so only the
  // refresh in flight, run once more, can replace the answer the patch refused.
  const refetch: readonly Slice[] =
    !state.company && (patch.employees || patch.resting) ? ["all"] : reload;
  await Promise.all(refetch.map((slice) => RELOAD[slice]()));
  if (recheckAuth) {
    await loadAuth();
  }
  if (roster) {
    await walkThroughDoor(roster);
  }
};

/** For main's event stream, which awaits nothing: a failure is logged, and the next event or refresh catches up. */
const onActivityInBackground = async (e: ActivityEvent): Promise<void> => {
  try {
    await onActivity(e);
  } catch (error) {
    console.error("Could not apply an activity event", error);
  }
};

// ---- lifecycle -------------------------------------------------------------

const loadStripeStatus = async (): Promise<void> => {
  set({ stripeStatus: await api().stripe.status() });
};

let initialized = false;
export const initStore = (): void => {
  if (initialized) {
    return;
  }
  initialized = true;
  void refreshInBackground();
  void loadAuth();
  void loadStripeStatus();
  void loadStripeKey();
  listen("activity", (e) => {
    void onActivityInBackground(e);
  });
  listen("stripe", (s: StripeStatus) => set({ stripeStatus: s }));
  listen("auth", (e: AuthFlowEvent) => {
    if (e.type === "done") {
      set({ authed: true });
      // a runner whose sign-in failed beside one that is ready stays signed out
      void loadAuth();
    }
  });
};
