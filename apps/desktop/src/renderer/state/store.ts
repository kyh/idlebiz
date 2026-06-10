import { useSyncExternalStore } from "react";
import type Phaser from "phaser";
import type { ActivityEvent, Company, Employee, Task } from "@/shared/domain";

interface State {
  booted: boolean;
  authed: boolean;
  liveMetrics: boolean; // true when real-world providers (Stripe/analytics) feed the numbers
  company: Company | null;
  employees: Employee[];
  activity: ActivityEvent[];
  pendingAsks: Task[]; // blocked tasks awaiting the founder's answer
  game: Phaser.Game | null;
}

let state: State = { booted: false, authed: true, liveMetrics: false, company: null, employees: [], activity: [], pendingAsks: [], game: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
const getState = (): State => state;
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export function useStore(): State {
  return useSyncExternalStore(subscribe, getState, getState);
}

const bridge = (): NonNullable<typeof window.appBridge> => {
  const b = window.appBridge;
  if (!b) throw new Error("appBridge unavailable");
  return b;
};

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
  bridge().onActivity((e: ActivityEvent) => onActivity(e));
}

export function setAuthed(ok: boolean): void {
  set({ authed: ok });
}

export function setGame(game: Phaser.Game): void {
  set({ game });
}

/** Toggle Phaser keyboard so typing in overlays doesn't move the player. */
export function setModalOpen(open: boolean): void {
  state.game?.events.emit("ui-modal", open);
}

export async function refresh(): Promise<void> {
  const company = await bridge().getCompany();
  const employees = company ? await bridge().listEmployees({ companyId: company.id }) : [];
  const tasks = company ? await bridge().listTasks({ companyId: company.id }) : [];
  const pendingAsks = tasks.filter((t) => t.status === "blocked" && t.blockedQuestion !== null);
  set({ booted: true, company, employees, pendingAsks });
}

function onActivity(e: ActivityEvent): void {
  const activity = [...state.activity, e].slice(-300);
  // live-patch employee status from run status events (keeps HUD + dialogue badge live)
  let employees = state.employees;
  if (e.kind === "status" && e.employeeId && typeof e.message === "string") {
    const next = e.message === "running" ? "working" : ["done", "failed", "cancelled", "blocked"].includes(e.message) ? "idle" : null;
    if (next) employees = employees.map((emp) => (emp.id === e.employeeId ? { ...emp, status: next } : emp));
  }
  set({ activity, employees });
  if (e.kind === "lifecycle" && e.message === "metrics.pulse" && e.payload && typeof e.payload === "object" && "real" in e.payload) {
    set({ liveMetrics: (e.payload as { real?: unknown }).real === true });
  }
  if (e.kind === "lifecycle" && (e.message === "run.end" || e.message === "metrics.pulse")) void refresh();
}

// ---- actions ---------------------------------------------------------------
export async function createCompany(input: {
  name: string;
  mission: string;
  founderName: string;
  founderSpriteSeed: string;
}): Promise<Company> {
  const company = await bridge().createCompany(input);
  await refresh();
  return company;
}

export async function setAutopilot(running: boolean): Promise<void> {
  const c = state.company;
  if (!c) return;
  const updated = await bridge().setAutopilot({ companyId: c.id, running });
  set({ company: updated });
}

export async function hireEmployee(input: {
  name: string;
  role: string;
  title: string;
  persona: string;
  spriteSeed: string;
}): Promise<Employee | null> {
  const company = state.company;
  if (!company) return null;
  const deskIndex = state.employees.length;
  const emp = await bridge().createEmployee({ companyId: company.id, deskIndex, ...input });
  await refresh();
  state.game?.events.emit("spawn-employee", emp);
  return emp;
}

export async function assignWork(employeeId: string, title: string, description: string): Promise<Task | null> {
  const company = state.company;
  if (!company) return null;
  const task = await bridge().createTask({ companyId: company.id, title, description, priority: "high", assigneeId: employeeId });
  const assigned = await bridge().assignTask({ taskId: task.id, employeeId });
  await refresh();
  return assigned;
}

export async function listTasksFor(employeeId: string): Promise<Task[]> {
  const company = state.company;
  if (!company) return [];
  const tasks = await bridge().listTasks({ companyId: company.id });
  return tasks.filter((t) => t.assigneeId === employeeId);
}
