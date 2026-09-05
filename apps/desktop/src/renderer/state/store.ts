import { useSyncExternalStore } from "react";
import type Phaser from "phaser";
import type { ActivityEvent } from "@/shared/activity";
import { employeeStatusOf, taskIn } from "@/shared/domain";
import type { Budget, Company, Employee, Task, TaskIn, TeamMessage } from "@/shared/domain";
import type {
  LoadSkip,
  ProductStatus,
  RestingRunners,
  StripeStatus,
  VercelStatus,
} from "@/shared/ipc-registry";
import {
  BUNDLED_LAYOUT,
  parseOfficeLayout,
  type OfficeLayoutData,
} from "@/renderer/game/office-layout";
import { bridge } from "@/renderer/bridge";

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
  vercelStatus: VercelStatus;
  product: ProductStatus | null; // PRODUCT.md entry + latest deploy
  resting: RestingRunners;
  /** Packages boot could not read. A skipped company blocks the office (see App). */
  saveIssues: LoadSkip[];
  company: Company | null;
  employees: Employee[];
  activity: ActivityEvent[];
  pendingAsks: TaskIn<"blocked">[]; // awaiting the founder's answer
  stuckTasks: TaskIn<"dead">[]; // dead-lettered, needing a retry
  game: Phaser.Game | null;
  modalOpen: boolean; // a dialogue/modal overlay is up (ambient HUD chrome hides)
  /** Derived on every set(): what the window shows, one of four. */
  boot: Boot;
}

let state: State = {
  booted: false,
  layout: null,
  authed: true,
  stripeStatus: { state: "disconnected" },
  vercelStatus: { state: "disconnected" },
  product: null,
  resting: {},
  saveIssues: [],
  company: null,
  employees: [],
  activity: [],
  pendingAsks: [],
  stuckTasks: [],
  game: null,
  modalOpen: false,
  boot: { kind: "loading" },
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

function bootOf(s: Omit<State, "boot">): Boot {
  const issues = s.saveIssues.filter((issue) => issue.kind === "company");
  if (issues.length > 0) return { kind: "unreadable", issues };
  if (!s.booted) return { kind: "loading" };
  if (!s.company) return { kind: "onboarding" };
  return { kind: "office", company: s.company, authed: s.authed };
}

function set(patch: Partial<Omit<State, "boot">>): void {
  const next = { ...state, ...patch };
  state = { ...next, boot: bootOf(next) };
  for (const l of listeners) l();
}
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

// ---- portrait cache --------------------------------------------------------
const portraitCache = new Map<string, string>();
export async function getPortrait(seed: string): Promise<string> {
  const cached = portraitCache.get(seed);
  if (cached) return cached;
  const assets = await bridge().composeCharacter({ seed });
  portraitCache.set(seed, assets.portraitDataUrl);
  return assets.portraitDataUrl;
}

// ---- lifecycle -------------------------------------------------------------
let initialized = false;
export function initStore(): void {
  if (initialized) return;
  initialized = true;
  void refresh();
  void bridge()
    .hasAuth()
    .then((r) => set({ authed: r.ok }));
  void bridge()
    .stripeStatus()
    .then((s) => set({ stripeStatus: s }));
  void bridge()
    .vercelStatus()
    .then((s) => set({ vercelStatus: s }));
  bridge().onActivity((e: ActivityEvent) => onActivity(e));
  bridge().onStripeStatus((s: StripeStatus) => set({ stripeStatus: s }));
}

export function setAuthed(ok: boolean): void {
  set({ authed: ok });
}

export function setGame(game: Phaser.Game): void {
  set({ game });
}

/** Toggle Phaser keyboard so typing in overlays doesn't move the player. */
export function setModalOpen(open: boolean): void {
  set({ modalOpen: open });
  state.game?.events.emit("ui-modal", open);
}

/**
 * Recover the player's saved office from disk before the Phaser scene boots; a
 * malformed file falls back to the bundled default. Once: the scene has built
 * the room by the time anything refreshes again.
 */
async function settleLayout(): Promise<void> {
  if (state.layout) return;
  let layout = BUNDLED_LAYOUT;
  try {
    const office = await bridge().loadOfficeDesign();
    if (office.layout) layout = parseOfficeLayout(office.layout);
  } catch {
    // keep the bundled default layout
  }
  // The scene may mount now. Not `booted`: that also opens the HUD and the
  // onboarding modal, and a founder shown onboarding because the bridge is down
  // would create a second company on top of the one they have.
  set({ layout });
}

/** The builder saved an office: the scene rebuilds from it when it next mounts. */
export function setLayout(layout: OfficeLayoutData): void {
  set({ layout });
}

export async function refresh(): Promise<void> {
  await settleLayout();
  const [company, resting, load] = await Promise.all([
    bridge().getCompany(),
    bridge().restingRunners(),
    bridge().loadReport(),
  ]);
  const [employees, tasks] = company
    ? await Promise.all([
        bridge().listEmployees({ companyId: company.id }),
        bridge().listTasks({ companyId: company.id, status: ["blocked", "dead"] }),
      ])
    : [[], []];
  const pendingAsks = tasks.filter(taskIn("blocked"));
  const stuckTasks = tasks.filter(taskIn("dead"));
  set({
    booted: true,
    company,
    resting,
    saveIssues: load.skipped,
    employees,
    pendingAsks,
    stuckTasks,
  });
  // product state rides along (deploy lookup is a no-op until Vercel is connected)
  if (company) {
    void bridge()
      .productStatus({ companyId: company.id })
      .then((product) => set({ product }))
      .catch(() => undefined);
  }
}

/** Fetch a team's chat-room messages on demand (for the Teams panel). */
export async function teamMessages(limit = 30): Promise<TeamMessage[]> {
  const c = state.company;
  return c ? bridge().teamMessages({ companyId: c.id, limit }) : [];
}

const ACTIVITY_RING = 300;

function onActivity(e: ActivityEvent): void {
  const ring = state.activity;
  const activity = ring.length >= ACTIVITY_RING ? [...ring.slice(1), e] : [...ring, e];
  switch (e.kind) {
    // live-patch employee status from run status events (keeps HUD + dialogue badge live)
    case "status": {
      const employeeId = e.employeeId;
      const status = employeeStatusOf(e.message);
      set({
        activity,
        employees: employeeId
          ? state.employees.map((emp) => (emp.id === employeeId ? { ...emp, status } : emp))
          : state.employees,
      });
      return;
    }
    // a CLI hit its usage limit — remember until when, so the HUD can say why
    case "runner.resting":
      set({ activity, resting: { ...state.resting, [e.payload.runner]: e.payload.until } });
      return;
    // both only move company fields — refetch just the company, not the world
    case "metrics.pulse":
    case "autopilot.changed":
    case "budget.exhausted":
      set({ activity });
      void bridge()
        .getCompany()
        .then((company) => set({ company }))
        .catch(() => undefined);
      return;
    // the team self-sizes: reflect hires/releases in the office immediately
    case "org.hired":
    case "org.released": {
      set({ activity });
      const hired = e.kind === "org.hired";
      const employeeId = e.employeeId;
      void refresh().then(() => {
        if (hired && employeeId) {
          const emp = state.employees.find((x) => x.id === employeeId);
          if (emp) state.game?.events.emit("spawn-employee", emp);
        } else if (employeeId) {
          state.game?.events.emit("despawn-employee", employeeId); // surgical — no scene rebuild
        }
        return null;
      });
      return;
    }
    case "run.end":
      set({ activity });
      void refresh();
      return;
    default:
      set({ activity });
      return;
  }
}

// ---- actions ---------------------------------------------------------------

/** Every action on the company: nothing to do without one. */
async function withCompany(act: (companyId: string) => Promise<void>): Promise<void> {
  if (state.company) await act(state.company.id);
}
/** An action whose reply is the company as main now has it. */
const updateCompany = (call: (companyId: string) => Promise<Company>): Promise<void> =>
  withCompany(async (companyId) => set({ company: await call(companyId) }));

export const setAutopilot = (running: boolean): Promise<void> =>
  updateCompany((companyId) => bridge().setAutopilot({ companyId, running }));

export const setBudget = (budget: Budget): Promise<void> =>
  updateCompany((companyId) => bridge().setBudget({ companyId, budget }));

export const resetSpend = (): Promise<void> =>
  updateCompany((companyId) => bridge().resetSpend({ companyId }));

export const setMaxAgents = (maxAgents: number): Promise<void> =>
  updateCompany((companyId) => bridge().setMaxAgents({ companyId, maxAgents }));

export const connectStripe = (): Promise<void> =>
  withCompany(async (companyId) => {
    await bridge().stripeConnect({ companyId });
  });

export const disconnectStripe = (): Promise<void> =>
  withCompany(async (companyId) => {
    await bridge().stripeDisconnect({ companyId });
  });

export const connectVercel = (input: {
  token: string;
  projectId: string;
  projectName: string;
  teamId?: string;
}): Promise<void> =>
  withCompany(async (companyId) => {
    await bridge().vercelConnect({ companyId, ...input });
    set({ vercelStatus: await bridge().vercelStatus() });
  });

export const disconnectVercel = (): Promise<void> =>
  withCompany(async (companyId) => {
    await bridge().vercelDisconnect({ companyId });
    set({ vercelStatus: { state: "disconnected" } });
  });

export async function resetGame(): Promise<void> {
  await bridge().resetGame();
}

/** Founder tells one employee what to do; the room records it, they wake on it. */
export async function directEmployee(employeeId: string, instruction: string): Promise<void> {
  const text = instruction.trim();
  if (!text) return;
  await bridge().directEmployee({ employeeId, instruction: text });
}

/** Founder posts in the team channel; @first-name wakes that employee. */
export const sendFounderChat = (text: string): Promise<void> =>
  withCompany(async (companyId) => {
    if (text.trim()) await bridge().postTeamChat({ companyId, text: text.trim() });
  });

/** Founder decides on a held outward-facing command; the task resumes either way. */
export async function resolveApproval(taskId: string, approved: boolean): Promise<void> {
  await bridge().resolveApproval({ taskId, approved });
  await refresh();
}

/** Revive a dead-lettered / failed task: re-assign it (the claim resets retries). */
export async function retryTask(task: Task): Promise<void> {
  if (!task.assigneeId) return;
  await bridge().assignTask({ taskId: task.id, employeeId: task.assigneeId });
  await refresh();
}

/** An employee's live work: what they are on and what they are stuck on. */
export async function listTasksFor(employeeId: string): Promise<Task[]> {
  const company = state.company;
  if (!company) return [];
  return bridge().listTasks({
    companyId: company.id,
    assigneeId: employeeId,
    status: ["queued", "running", "blocked"],
  });
}

/** Answer the question a blocked task is waiting on; the task resumes. */
export async function answerQuestion(taskId: string, answer: string): Promise<void> {
  await bridge().answerQuestion({ taskId, answer });
  await refresh();
}

export async function openSaveFolder(): Promise<void> {
  await bridge().openSaveFolder();
}
