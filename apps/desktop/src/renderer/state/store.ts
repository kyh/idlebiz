import { useSyncExternalStore } from "react";
import type Phaser from "phaser";
import type { ActivityEvent } from "@/shared/activity";
import type { Bet } from "@/shared/bets";
import { taskIn } from "@/shared/domain";
import type {
  Budget,
  Company,
  Employee,
  LoadSkip,
  Product,
  RestingRunners,
  Task,
  TaskIn,
  TeamMessage,
} from "@/shared/domain";
import type { Digest } from "@/shared/digest";
import type { ProductStatus, StripeStatus } from "@/shared/integrations";
import { BUNDLED_LAYOUT, parseOfficeLayout } from "@/renderer/game/office-layout";
import type { OfficeLayoutData } from "@/renderer/game/office-layout";
import { bridge } from "@/renderer/bridge";
import { hear, tell } from "@/renderer/game/office-port";
import { reduceActivity } from "@/renderer/state/activity-reducer";
import type { Slice } from "@/renderer/state/activity-reducer";
import { Coalesced, latestWins } from "@/renderer/state/ordering";

interface State {
  /** The first refresh finished: company, roster and tasks are known (or known absent). */
  booted: boolean;
  /**
   * The office layout in force: the saved office from disk, else the bundled
   * default; null until that is known, and the scene mounts on nothing earlier.
   * Settled before the bridge calls that can fail, so the room opens even when
   * they do.
   */
  layout: OfficeLayoutData | null;
  authed: boolean;
  stripeStatus: StripeStatus;
  /** Everything the company builds, oldest first, and where each one really is. */
  products: Product[];
  productStatus: ReadonlyMap<string, ProductStatus>;
  /** Every bet the company has made, oldest first. */
  bets: Bet[];
  resting: RestingRunners;
  /** Packages boot could not read. A skipped company blocks the office (see App). */
  saveIssues: LoadSkip[];
  company: Company | null;
  employees: Employee[];
  activity: ActivityEvent[];
  /** Awaiting the founder's answer. */
  pendingAsks: TaskIn<"blocked">[];
  /** Dead-lettered, needing a retry. */
  stuckTasks: TaskIn<"dead">[];
  game: Phaser.Game | null;
  /** A dialogue/modal overlay is up (ambient HUD chrome hides). */
  modalOpen: boolean;
  /** The employee the founder is talking to, from the office or the roster. */
  talkingTo: string | null;
  /** Derived on every set(): what the window shows, one of four. */
  boot: Boot;
}

let state: State = {
  activity: [],
  authed: true,
  bets: [],
  boot: { kind: "loading" },
  booted: false,
  company: null,
  employees: [],
  game: null,
  layout: null,
  modalOpen: false,
  pendingAsks: [],
  productStatus: new Map(),
  products: [],
  resting: {},
  saveIssues: [],
  stripeStatus: { state: "disconnected" },
  stuckTasks: [],
  talkingTo: null,
};
const listeners = new Set<() => void>();

/**
 * What the window shows: exactly one of these. A company boot could not read
 * stops everything (a fresh start here would stack a second company on it);
 * no company means onboarding; a company means the office, gated on a CLI.
 */
export type Boot =
  | { kind: "loading" }
  | { kind: "unreadable"; issues: LoadSkip[] }
  | { kind: "onboarding" }
  | { kind: "office"; company: Company; authed: boolean };

const bootOf = (s: Omit<State, "boot">): Boot => {
  const issues = s.saveIssues.filter((issue) => issue.kind === "company");
  if (issues.length > 0) {
    return { issues, kind: "unreadable" };
  }
  if (!s.booted) {
    return { kind: "loading" };
  }
  if (!s.company) {
    return { kind: "onboarding" };
  }
  return { authed: s.authed, company: s.company, kind: "office" };
};

const set = (patch: Partial<Omit<State, "boot">>): void => {
  const next = { ...state, ...patch };
  state = { ...next, boot: bootOf(next) };
  for (const l of listeners) {
    l();
  }
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Subscribe to the store. With a selector the component re-renders only when
 * the selected value changes — so select a field, not a fresh object.
 */
export function useStore(): State;
export function useStore<T>(selector: (s: State) => T): T;
export function useStore<T>(selector?: (s: State) => T): T | State {
  const select = (): T | State => (selector ? selector(state) : state);
  return useSyncExternalStore(subscribe, select, select);
}

export const setAuthed = (ok: boolean): void => {
  set({ authed: ok });
};

// Scene startup can finish after an overlay mounted; replay the current keyboard state.
const syncModal = (): void => {
  if (state.game) {
    tell(state.game, "ui-modal", state.modalOpen);
  }
};

let stopHearingInputReady: (() => void) | null = null;

export const setGame = (game: Phaser.Game | null): void => {
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

/**
 * Recover the player's saved office from disk before the Phaser scene boots; a
 * malformed file falls back to the bundled default. Once: the scene has built
 * the room by the time anything refreshes again.
 */
const settleLayout = async (): Promise<void> => {
  if (state.layout) {
    return;
  }
  let layout = BUNDLED_LAYOUT;
  try {
    const office = await bridge().loadOfficeDesign();
    if (office.layout) {
      layout = parseOfficeLayout(office.layout);
    }
  } catch {
    // keep the bundled default layout
  }
  // The scene may mount now. Not `booted`: that also opens the HUD and the
  // onboarding modal, and a founder shown onboarding because the bridge is down
  // would create a second company on top of the one they have.
  set({ layout });
};

/** The builder saved an office: the scene rebuilds from it when it next mounts. */
export const setLayout = (layout: OfficeLayoutData): void => {
  set({ layout });
};

/** Where each product really is: its entry and latest deploy (a lookup only for bound products). */
const refreshProductStatus = async (products: readonly Product[]): Promise<void> => {
  const entries = await Promise.all(
    products.map(async (p) => {
      try {
        return [p.id, await bridge().productStatus({ productId: p.id })] as const;
      } catch {
        return null;
      }
    }),
  );
  set({ productStatus: new Map(entries.filter((entry) => entry !== null)) });
};

const order = latestWins();

const splitTasks = (tasks: readonly Task[]): Pick<State, "pendingAsks" | "stuckTasks"> => ({
  pendingAsks: tasks.filter(taskIn("blocked")),
  stuckTasks: tasks.filter(taskIn("dead")),
});

const refreshOnce = async (): Promise<void> => {
  await settleLayout();
  const ticket = order.ticket();
  const [company, resting, load] = await Promise.all([
    bridge().getCompany(),
    bridge().restingRunners(),
    bridge().loadReport(),
  ]);
  const [employees, tasks, products, bets] = company
    ? await Promise.all([
        bridge().listEmployees(),
        bridge().listTasks({ status: ["blocked", "dead"] }),
        bridge().listProducts(),
        bridge().listBets(),
      ])
    : [[], [], [], []];
  // a slice a newer request already answered keeps the newer answer
  const patch: Partial<Omit<State, "boot">> = { booted: true, resting, saveIssues: load.skipped };
  if (order.accepts("company", ticket)) {
    patch.company = company;
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
    void refreshProductStatus(products);
  }
};

const refreshing = new Coalesced(refreshOnce);

export const refresh = (): Promise<void> => refreshing.call();

/** Fetch one slice again, keeping the answer only if nothing newer has landed. */
const reloadSlice = async <T>(
  slice: string,
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

const reloadProducts = (): Promise<void> =>
  reloadSlice(
    "products",
    () => bridge().listProducts(),
    (products) => {
      set({ products });
      void refreshProductStatus(products);
    },
  );

const reloadBets = (): Promise<void> =>
  reloadSlice(
    "bets",
    () => bridge().listBets(),
    (bets) => set({ bets }),
  );

const reloadTasks = (): Promise<void> =>
  reloadSlice(
    "tasks",
    () => bridge().listTasks({ status: ["blocked", "dead"] }),
    (tasks) => set(splitTasks(tasks)),
  );

const reloadCompany = (): Promise<void> =>
  reloadSlice(
    "company",
    () => bridge().getCompany(),
    (company) => set({ company }),
  );

// ---- actions ---------------------------------------------------------------

const withCompany = async (act: () => Promise<void>): Promise<void> => {
  if (state.company) {
    await act();
  }
};
const updateCompany = (call: () => Promise<Company>): Promise<void> =>
  withCompany(async () => set({ company: await call() }));

// main answers both with `bet.changed` / `product.killed`, and those events reload what moved
export const killBet = async (betId: string, reason: string): Promise<void> => {
  await bridge().killBet({ betId, reason });
};

export const killProduct = async (productId: string, reason: string): Promise<void> => {
  await bridge().killProduct({ productId, reason });
};

export const createProduct = (name: string, description: string): Promise<void> =>
  withCompany(async () => {
    await bridge().createProduct({ description, name });
    await reloadProducts();
  });

export const teamMessages = async (limit = 30): Promise<TeamMessage[]> => {
  const c = state.company;
  return c ? await bridge().teamMessages({ limit }) : [];
};

export const setAutopilot = (running: boolean): Promise<void> =>
  updateCompany(() => bridge().setAutopilot({ running }));

export const setBudget = (budget: Budget): Promise<void> =>
  updateCompany(() => bridge().setBudget({ budget }));

export const resetSpend = (): Promise<void> => updateCompany(() => bridge().resetSpend());

/** What happened since the founder last looked; asking is the look. */
export const digest = (): Promise<Digest | null> =>
  state.company ? bridge().takeDigest() : Promise.resolve(null);

export const setMaxAgents = (maxAgents: number): Promise<void> =>
  updateCompany(() => bridge().setMaxAgents({ maxAgents }));

export const connectStripe = (): Promise<void> =>
  withCompany(async () => {
    await bridge().stripeConnect();
  });

export const disconnectStripe = (): Promise<void> =>
  withCompany(async () => {
    await bridge().stripeDisconnect();
  });

export const connectVercel = async (input: {
  productId: string;
  token: string;
  projectId: string;
  projectName: string;
  teamId?: string;
}): Promise<void> => {
  await bridge().vercelConnect(input);
  await reloadProducts();
};

export const disconnectVercel = async (productId: string): Promise<void> => {
  await bridge().vercelDisconnect({ productId });
  await reloadProducts();
};

export const directEmployee = async (employeeId: string, instruction: string): Promise<void> => {
  const text = instruction.trim();
  if (!text) {
    return;
  }
  await bridge().directEmployee({ employeeId, instruction: text });
};

/** Founder posts in the team channel; @first-name wakes that employee. */
export const sendFounderChat = (text: string): Promise<void> =>
  withCompany(async () => {
    if (text.trim()) {
      await bridge().postTeamChat({ text: text.trim() });
    }
  });

/** Founder decides on a held outward-facing command; the task resumes either way. */
export const resolveApproval = async (taskId: string, approved: boolean): Promise<void> => {
  await bridge().resolveApproval({ approved, taskId });
  await refresh();
};

/** Revive a dead-lettered / failed task: re-assign it (the claim resets retries). */
export const retryTask = async (task: Task): Promise<void> => {
  if (!task.assigneeId) {
    return;
  }
  await bridge().assignTask({ employeeId: task.assigneeId, taskId: task.id });
  await refresh();
};

export const listTasksFor = async (employeeId: string): Promise<Task[]> => {
  const { company } = state;
  if (!company) {
    return [];
  }
  return await bridge().listTasks({
    assigneeId: employeeId,
    status: ["queued", "running", "blocked"],
  });
};

const refreshAfterAnswer = async (): Promise<void> => {
  try {
    await refresh();
  } catch (error) {
    console.error("Could not refresh after answering", error);
  }
};

export const answerQuestion = async (taskId: string, answer: string): Promise<void> => {
  await bridge().answerQuestion({ answer, taskId });
  void refreshAfterAnswer();
};

// ---- activity --------------------------------------------------------------

const RELOAD = {
  all: refresh,
  bets: reloadBets,
  company: reloadCompany,
  products: reloadProducts,
  tasks: reloadTasks,
} satisfies Record<Slice, () => Promise<void>>;

// Surgical: the one employee walks in or out, no scene rebuild.
const walkThroughDoor = (roster: { employeeId: string; hired: boolean }): void => {
  const { game } = state;
  if (!game) {
    return;
  }
  if (!roster.hired) {
    tell(game, "despawn-employee", roster.employeeId);
    return;
  }
  const hire = state.employees.find((emp) => emp.id === roster.employeeId);
  if (hire) {
    tell(game, "spawn-employee", hire);
  }
};

const onActivity = async (e: ActivityEvent): Promise<void> => {
  const { patch, reload, roster } = reduceActivity(state, e);
  set(patch);
  await Promise.all(reload.map((slice) => RELOAD[slice]()));
  if (roster) {
    walkThroughDoor(roster);
  }
};

// ---- lifecycle -------------------------------------------------------------

const loadAuth = async (): Promise<void> => {
  const r = await bridge().hasAuth();
  set({ authed: r.ok });
};

const loadStripeStatus = async (): Promise<void> => {
  set({ stripeStatus: await bridge().stripeStatus() });
};

let initialized = false;
export const initStore = (): void => {
  if (initialized) {
    return;
  }
  initialized = true;
  void refresh();
  void loadAuth();
  void loadStripeStatus();
  bridge().onActivity(onActivity);
  bridge().onStripeStatus((s: StripeStatus) => set({ stripeStatus: s }));
};
