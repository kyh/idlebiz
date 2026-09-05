import { useSyncExternalStore } from "react";
import type Phaser from "phaser";
import type { ActivityEvent } from "@/shared/activity";
import { taskIn } from "@/shared/domain";
import type { Budget, Company, Employee, Task, TaskIn, Team, TeamMessage } from "@/shared/domain";
import type {
  LoadSkip,
  ProductStatus,
  RestingRunners,
  StripeStatus,
  VercelStatus,
} from "@/shared/ipc-registry";
import { applyOfficeLayout } from "@/renderer/game/office-layout";
import { bridge } from "@/renderer/bridge";

interface State {
  /** The first refresh finished: company, roster and tasks are known (or known absent). */
  booted: boolean;
  /**
   * The office layout is settled — saved office applied, or the bundled default kept.
   * The scene mounts on this and nothing earlier: its preload reads the live layout
   * bindings the moment the game exists, so mounting first would build the bundled
   * office. Set before the bridge calls that can fail, so the room opens even when
   * they do.
   */
  layoutReady: boolean;
  authed: boolean;
  stripeStatus: StripeStatus;
  vercelStatus: VercelStatus;
  product: ProductStatus | null; // PRODUCT.md entry + latest deploy
  resting: RestingRunners;
  /** Packages boot could not read. A skipped company blocks the office (see App). */
  saveIssues: LoadSkip[];
  company: Company | null;
  employees: Employee[];
  teams: Team[];
  activity: ActivityEvent[];
  pendingAsks: TaskIn<"blocked">[]; // awaiting the founder's answer
  stuckTasks: TaskIn<"dead">[]; // dead-lettered, needing a retry
  game: Phaser.Game | null;
  modalOpen: boolean; // a dialogue/modal overlay is up (ambient HUD chrome hides)
}

let state: State = {
  booted: false,
  layoutReady: false,
  authed: true,
  stripeStatus: { state: "disconnected" },
  vercelStatus: { state: "disconnected" },
  product: null,
  resting: {},
  saveIssues: [],
  company: null,
  employees: [],
  teams: [],
  activity: [],
  pendingAsks: [],
  stuckTasks: [],
  game: null,
  modalOpen: false,
};
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
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
  if (state.layoutReady) return;
  try {
    const office = await bridge().loadOfficeDesign();
    if (office.layout) applyOfficeLayout(office.layout);
  } catch {
    // keep the bundled default layout
  }
  // The scene may mount now. Not `booted`: that also opens the HUD and the
  // onboarding modal, and a founder shown onboarding because the bridge is down
  // would create a second company on top of the one they have.
  set({ layoutReady: true });
}

export async function refresh(): Promise<void> {
  await settleLayout();
  const [company, resting, load] = await Promise.all([
    bridge().getCompany(),
    bridge().restingRunners(),
    bridge().loadReport(),
  ]);
  const [employees, teams, tasks] = company
    ? await Promise.all([
        bridge().listEmployees({ companyId: company.id }),
        bridge().listTeams({ companyId: company.id }),
        bridge().listTasks({ companyId: company.id, status: ["blocked", "dead"] }),
      ])
    : [[], [], []];
  const pendingAsks = tasks.filter(taskIn("blocked"));
  const stuckTasks = tasks.filter(taskIn("dead"));
  set({
    booted: true,
    company,
    resting,
    saveIssues: load.skipped,
    employees,
    teams,
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
export async function teamMessages(teamId: string, limit = 30): Promise<TeamMessage[]> {
  return bridge().teamMessages({ teamId, limit });
}

function onActivity(e: ActivityEvent): void {
  const activity = [...state.activity, e].slice(-300);
  set({ activity });
  switch (e.kind) {
    // live-patch employee status from run status events (keeps HUD + dialogue badge live)
    case "status": {
      if (!e.employeeId) return;
      const status = e.message === "running" ? "working" : "idle";
      set({
        employees: state.employees.map((emp) =>
          emp.id === e.employeeId ? { ...emp, status } : emp,
        ),
      });
      return;
    }
    // a CLI hit its usage limit — remember until when, so the HUD can say why
    case "runner.resting":
      set({ resting: { ...state.resting, [e.payload.runner]: e.payload.until } });
      return;
    // both only move company fields — refetch just the company, not the world
    case "metrics.pulse":
    case "autopilot.changed":
    case "budget.exhausted":
      void bridge()
        .getCompany()
        .then((company) => set({ company }))
        .catch(() => undefined);
      return;
    // the team self-sizes: reflect hires/releases in the office immediately
    case "org.hired":
    case "org.released": {
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
      void refresh();
      return;
    default:
      return;
  }
}

// ---- actions ---------------------------------------------------------------

export async function setAutopilot(running: boolean): Promise<void> {
  const c = state.company;
  if (!c) return;
  const updated = await bridge().setAutopilot({ companyId: c.id, running });
  set({ company: updated });
}

export async function setBudget(budget: Budget): Promise<void> {
  const c = state.company;
  if (!c) return;
  const updated = await bridge().setBudget({ companyId: c.id, budget });
  set({ company: updated });
}

export async function resetSpend(): Promise<void> {
  const c = state.company;
  if (!c) return;
  const updated = await bridge().resetSpend({ companyId: c.id });
  set({ company: updated });
}

export async function connectStripe(): Promise<void> {
  const c = state.company;
  if (!c) return;
  await bridge().stripeConnect({ companyId: c.id });
}

export async function disconnectStripe(): Promise<void> {
  const c = state.company;
  if (!c) return;
  await bridge().stripeDisconnect({ companyId: c.id });
}

export async function connectVercel(input: {
  token: string;
  projectId: string;
  projectName: string;
  teamId?: string;
}): Promise<void> {
  const c = state.company;
  if (!c) return;
  await bridge().vercelConnect({ companyId: c.id, ...input });
  set({ vercelStatus: await bridge().vercelStatus() });
}

export async function disconnectVercel(): Promise<void> {
  const c = state.company;
  if (!c) return;
  await bridge().vercelDisconnect({ companyId: c.id });
  set({ vercelStatus: { state: "disconnected" } });
}

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
export async function sendFounderChat(text: string): Promise<void> {
  const team = state.teams[0];
  if (!team || !text.trim()) return;
  await bridge().postTeamChat({ teamId: team.id, text: text.trim() });
}

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

export async function listTasksFor(employeeId: string): Promise<Task[]> {
  const company = state.company;
  if (!company) return [];
  return bridge().listTasks({ companyId: company.id, assigneeId: employeeId });
}

/** Answer the question a blocked task is waiting on; the task resumes. */
export async function answerQuestion(taskId: string, answer: string): Promise<void> {
  await bridge().answerQuestion({ taskId, answer });
  await refresh();
}

export async function setMaxAgents(maxAgents: number): Promise<void> {
  const c = state.company;
  if (!c) return;
  set({ company: await bridge().setMaxAgents({ companyId: c.id, maxAgents }) });
}

export async function openSaveFolder(): Promise<void> {
  await bridge().openSaveFolder();
}
