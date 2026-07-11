import { useSyncExternalStore } from "react";
import type Phaser from "phaser";
import type {
  ActivityEvent,
  Budget,
  Company,
  Employee,
  Task,
  Team,
  TeamMessage,
} from "@/shared/domain";
import type { ProductStatus, StripeStatus, VercelStatus } from "@/shared/ipc-registry";
import { applyOfficeLayout } from "@/renderer/game/office-layout";

interface State {
  booted: boolean;
  authed: boolean;
  stripeStatus: StripeStatus;
  vercelStatus: VercelStatus;
  product: ProductStatus | null; // PRODUCT.md entry + latest deploy
  resting: Record<string, number>; // runner -> epoch its usage limit lifts
  company: Company | null;
  employees: Employee[];
  teams: Team[];
  activity: ActivityEvent[];
  pendingAsks: Task[]; // blocked tasks awaiting the founder's answer
  stuckTasks: Task[]; // dead-lettered / failed tasks needing attention
  game: Phaser.Game | null;
  modalOpen: boolean; // a dialogue/modal overlay is up (ambient HUD chrome hides)
}

let state: State = {
  booted: false,
  authed: true,
  stripeStatus: { state: "disconnected" },
  vercelStatus: { state: "disconnected" },
  product: null,
  resting: {},
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

export async function refresh(): Promise<void> {
  // Recover the player's saved office from disk before the Phaser scene boots; a
  // malformed/old-schema file falls back to the bundled default.
  try {
    const office = await bridge().loadOfficeDesign();
    if (office.layout) applyOfficeLayout(office.layout);
  } catch {
    // keep the bundled default layout
  }
  const company = await bridge().getCompany();
  const employees = company ? await bridge().listEmployees({ companyId: company.id }) : [];
  const teams = company ? await bridge().listTeams({ companyId: company.id }) : [];
  const tasks = company ? await bridge().listTasks({ companyId: company.id }) : [];
  const pendingAsks = tasks.filter((t) => t.status === "blocked" && t.blocked !== null);
  const stuckTasks = tasks.filter((t) => t.status === "dead" || t.status === "failed");
  set({ booted: true, company, employees, teams, pendingAsks, stuckTasks });
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
  // live-patch employee status from run status events (keeps HUD + dialogue badge live)
  let employees = state.employees;
  if (e.kind === "status" && e.employeeId && typeof e.message === "string") {
    const next =
      e.message === "running"
        ? "working"
        : ["done", "failed", "cancelled", "blocked", "dead", "queued"].includes(e.message)
          ? "idle"
          : null;
    if (next)
      employees = employees.map((emp) =>
        emp.id === e.employeeId ? { ...emp, status: next } : emp,
      );
  }
  set({ activity, employees });
  // a CLI hit its usage limit — remember until when, so the HUD can say why
  if (e.kind === "lifecycle" && e.message === "runner.resting") {
    const p: unknown = e.payload;
    if (typeof p === "object" && p !== null && "runner" in p && "until" in p) {
      const runner = typeof p.runner === "string" ? p.runner : null;
      const until = typeof p.until === "number" ? p.until : null;
      if (runner && until) set({ resting: { ...state.resting, [runner]: until } });
    }
    return;
  }
  // both only move company fields — refetch just the company, not the world
  if (
    e.kind === "lifecycle" &&
    (e.message === "metrics.pulse" || e.message === "autopilot.changed")
  ) {
    void bridge()
      .getCompany()
      .then((company) => set({ company }))
      .catch(() => undefined);
    return;
  }
  // the team self-sizes: reflect hires/releases in the office immediately
  if (e.kind === "lifecycle" && (e.message === "org.hired" || e.message === "org.released")) {
    const hired = e.message === "org.hired";
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
  if (e.kind === "lifecycle" && e.message === "run.end") void refresh();
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

/** Founder posts in the team channel; @first-name wakes that employee. */
export async function sendFounderChat(text: string): Promise<void> {
  const team = state.teams[0];
  if (!team || !text.trim()) return;
  await bridge().postTeamChat({ teamId: team.id, text: text.trim() });
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
  const tasks = await bridge().listTasks({ companyId: company.id });
  return tasks.filter((t) => t.assigneeId === employeeId);
}
