import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, atomicWrite, readJsonFile, readJsonlTail } from "@/main/lib/fs";
import {
  ROOT_DIR,
  ensureAppDirs,
  companyDir,
  companyFile,
  companyWorkspace,
  activityFile,
  agentsDir,
  approvalsFile,
  alumniDir,
  employeeAgentDir,
  employeeFile,
  employeeMemoryDir,
  employeeSessionDir,
  tasksDir,
  taskFile,
  routinesDir,
  routineFile,
  chatFile,
  legacyTeamsDir,
} from "@/main/paths";
import {
  parseDoc,
  serializeDoc,
  slugify,
  reqStr,
  optStr,
  reqNum,
  optNum,
  nullableNum,
  optBool,
  type FrontmatterDoc,
} from "@/main/store/frontmatter";
import { z } from "zod";
import { answeredSummary, continuationBrief } from "@/main/prompts/briefs";
import { standingInstructions } from "@/main/prompts/instructions";
import { docToTask, taskToDoc } from "@/main/store/task-codec";
import { errorMessage } from "@/shared/errors";
import type { LoadReport, LoadSkip } from "@/shared/ipc-registry";
import { isRunnerId } from "@repo/agent-driver/runner";
import {
  BUSINESS_TYPES,
  DEFAULT_FOUNDER_SEED,
  DEFAULT_MAX_AGENTS,
  MAX_TASK_ATTEMPTS,
  businessTypeById,
} from "@/shared/domain";
import {
  PersistedActivitySchema,
  type ActivityEvent,
  type ActivityKind,
  type PersistedActivity,
} from "@/shared/activity";
import type {
  AgentRunner,
  TaskState,
  Budget,
  BusinessTypeId,
  Company,
  Employee,
  Routine,
  Task,
  TaskPriority,
  TeamMessage,
} from "@/shared/domain";

// ---------------------------------------------------------------------------
// Disk store: every company is an agentcompanies/v1 package under ~/.idlebiz.
// All state is held in an in-memory cache (single-threaded main process makes
// check-and-set atomic) and persisted to markdown files via atomic tmp+rename.
// The activity log is an append-only activity.jsonl per company.
// ---------------------------------------------------------------------------

interface Cache {
  companies: Map<string, Company>;
  employees: Map<string, Employee[]>; // companyId -> employees
  tasks: Map<string, Task[]>; // companyId -> tasks
  routines: Map<string, Routine[]>; // companyId -> routines
  chat: Map<string, TeamMessage[]>; // companyId -> recent room messages (ring)
  activity: ActivityEvent[]; // ring buffer across companies (UI stream)
  nextActivityId: number;
  nextTeamMessageId: number;
}

let cache: Cache | null = null;

function routineToDoc(r: Routine): FrontmatterDoc {
  const metadata: FrontmatterDoc["metadata"] = { intervalHours: r.intervalHours };
  if (r.role !== null) metadata.role = r.role;
  if (r.lastRunAt !== null) metadata.lastRunAt = r.lastRunAt;
  return {
    fields: { schema: "agentcompanies/v1", slug: r.id, name: r.name },
    metadata,
    body: `${r.instruction}\n`,
  };
}

function docToRoutine(doc: FrontmatterDoc, companyId: string): Routine {
  return {
    id: reqStr(doc.fields, "slug"),
    companyId,
    name: reqStr(doc.fields, "name"),
    instruction: doc.body.trim(),
    intervalHours: optNum(doc.metadata, "intervalHours", 24),
    role: optStr(doc.metadata, "role"),
    lastRunAt: nullableNum(doc.metadata, "lastRunAt"),
  };
}

function saveRoutine(r: Routine): void {
  atomicWrite(routineFile(r.companyId, r.id), serializeDoc(routineToDoc(r)));
}

function c(): Cache {
  if (!cache) throw new Error("store not initialized");
  return cache;
}

// ---- the cache's per-company lists, looked up by id ------------------------
interface Owned {
  id: string;
  companyId: string;
}

function findIn<T extends Owned>(lists: Map<string, T[]>, id: string): T | null {
  for (const list of lists.values()) {
    const found = list.find((row) => row.id === id);
    if (found) return found;
  }
  return null;
}

/** Replace a row in place with its patch applied (identity fields kept) and persist it. */
function patchIn<T extends Owned>(
  lists: Map<string, T[]>,
  id: string,
  patch: Partial<T>,
  save: (row: T) => void,
): T | null {
  for (const list of lists.values()) {
    const idx = list.findIndex((row) => row.id === id);
    const cur = list[idx];
    if (idx < 0 || !cur) continue;
    const next = { ...cur, ...patch, id: cur.id, companyId: cur.companyId };
    list[idx] = next;
    save(next);
    return next;
  }
  return null;
}

// ---- serialization ----------------------------------------------------------
function companyToDoc(co: Company): FrontmatterDoc {
  const metadata: FrontmatterDoc["metadata"] = {
    founderName: co.founderName,
    founderSpriteSeed: co.founderSpriteSeed,
    businessType: co.businessType,
    autopilot: co.autopilot,
    maxAgents: co.maxAgents,
    ships: co.ships,
  };
  if (co.leaderId !== null) metadata.leaderId = co.leaderId;
  // real metrics: absent keys mean "no source has ever reported"
  if (co.revenueUsd !== null) metadata.revenueUsd = co.revenueUsd;
  if (co.users !== null) metadata.users = co.users;
  metadata.budgetMode = co.budget.mode;
  if (co.budget.mode === "capped") metadata.budgetCapUsd = co.budget.capUsd;
  metadata.spentUsd = co.spentUsd;
  metadata.createdAt = co.createdAt;
  return {
    fields: {
      schema: "agentcompanies/v1",
      kind: "company",
      slug: co.id,
      name: co.name,
      description: co.mission,
    },
    metadata,
    body: `# ${co.name}\n\n${co.mission}\n`,
  };
}

function parseBusinessType(raw: string | null): BusinessTypeId {
  const found = BUSINESS_TYPES.find((b) => b.id === raw);
  return found ? found.id : "custom";
}

function parseBudget(m: FrontmatterDoc["metadata"]): Budget {
  if (optStr(m, "budgetMode") === "capped") {
    return { mode: "capped", capUsd: Math.max(0, optNum(m, "budgetCapUsd", 0)) };
  }
  return { mode: "infinite" };
}

function docToCompany(doc: FrontmatterDoc): Company {
  const f = doc.fields;
  const m = doc.metadata;
  const id = reqStr(f, "slug");
  return {
    id,
    name: reqStr(f, "name"),
    mission: optStr(f, "description") ?? "",
    businessType: parseBusinessType(optStr(m, "businessType")),
    workspaceDir: companyWorkspace(id),
    founderName: optStr(m, "founderName") ?? "Founder",
    founderSpriteSeed: optStr(m, "founderSpriteSeed") ?? DEFAULT_FOUNDER_SEED,
    autopilot: optBool(m, "autopilot", true),
    maxAgents: Math.max(1, optNum(m, "maxAgents", DEFAULT_MAX_AGENTS)),
    leaderId: optStr(m, "leaderId"),
    ships: optNum(m, "ships", 0),
    revenueUsd: nullableNum(m, "revenueUsd"),
    users: nullableNum(m, "users"),
    budget: parseBudget(m),
    spentUsd: Math.max(0, optNum(m, "spentUsd", 0)),
    createdAt: reqNum(m, "createdAt"),
  };
}

function parseRunner(v: string | null): AgentRunner {
  return v && isRunnerId(v) ? v : "codex";
}

/** The body of AGENTS.md doubles as the agent's actual instructions (injected into every run). */
function employeeBody(e: Employee, co: Company): string {
  return standingInstructions({
    employee: e,
    company: co,
    lead: co.leaderId === e.id,
    memoryDir: employeeMemoryDir(co.id, e.id),
  });
}

function employeeToDoc(e: Employee, co: Company): FrontmatterDoc {
  const metadata: FrontmatterDoc["metadata"] = {
    role: e.role,
    title: e.title,
    persona: e.persona,
    runner: e.runner,
    spriteSeed: e.spriteSeed,
    deskIndex: e.deskIndex,
    createdAt: e.createdAt,
  };
  if (e.sessionId !== null) metadata.sessionId = e.sessionId;
  return {
    fields: {
      schema: "agentcompanies/v1",
      kind: "agent",
      slug: e.id,
      name: e.name,
      description: e.title || e.role,
    },
    metadata,
    body: employeeBody(e, co),
  };
}

function docToEmployee(doc: FrontmatterDoc, companyId: string): Employee {
  const f = doc.fields;
  const m = doc.metadata;
  return {
    id: reqStr(f, "slug"),
    companyId,
    name: reqStr(f, "name"),
    role: optStr(m, "role") ?? "general",
    title: optStr(m, "title") ?? optStr(f, "description") ?? "",
    persona: optStr(m, "persona") ?? "",
    runner: parseRunner(optStr(m, "runner")),
    sessionId: optStr(m, "sessionId"),
    spriteSeed: optStr(m, "spriteSeed") ?? `emp-${reqStr(f, "slug")}`,
    deskIndex: optNum(m, "deskIndex", 0),
    status: "idle",
    createdAt: optNum(m, "createdAt", Date.now()),
  };
}

// ---- persistence ------------------------------------------------------------
function saveCompany(co: Company): void {
  atomicWrite(companyFile(co.id), serializeDoc(companyToDoc(co)));
}
function saveEmployee(e: Employee): void {
  const co = c().companies.get(e.companyId);
  if (!co) throw new Error(`company ${e.companyId} not found`);
  atomicWrite(employeeFile(e.companyId, e.id), serializeDoc(employeeToDoc(e, co)));
}
function saveTask(t: Task): void {
  atomicWrite(taskFile(t.companyId, t.id), serializeDoc(taskToDoc(t)));
}

const ACTIVITY_RING = 600;

// ---- boot -------------------------------------------------------------------
/** Oldest first; ties (same millisecond) by id, so boot order is stable. */
const byAge = <T extends { createdAt: number; id: string }>(a: T, b: T): number =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

// What boot could not read. A skipped task or agent is non-fatal and listed; a
// skipped company means the founder is looking at an empty office over a save
// that exists — the renderer must show them that, never onboarding.
let lastLoad: LoadReport = { companies: 0, skipped: [] };
export const loadReport = (): LoadReport => lastLoad;

/** A package at `path` did not decode; remember it for the founder. */
function skip(kind: LoadSkip["kind"], path: string, cause: unknown): void {
  lastLoad.skipped.push({ kind, path, error: errorMessage(cause) });
}

/**
 * Every package under `dir` that `decode` accepts. A package that fails to
 * decode is skipped and reported, not fatal: one hand-edited file must not
 * take the company down with it.
 */
function loadPackages<T>(
  kind: LoadSkip["kind"],
  dir: string,
  fileFor: (slug: string) => string,
  decode: (doc: FrontmatterDoc) => T,
): T[] {
  const rows: T[] = [];
  for (const slug of safeReaddir(dir)) {
    const file = fileFor(slug);
    if (!existsSync(file)) continue;
    try {
      rows.push(decode(parseDoc(readFileSync(file, "utf8"))));
    } catch (cause) {
      skip(kind, file, cause);
    }
  }
  return rows;
}

export function initStore(): LoadReport {
  ensureAppDirs();
  lastLoad = { companies: 0, skipped: [] };
  const loaded: Cache = {
    companies: new Map(),
    employees: new Map(),
    tasks: new Map(),
    routines: new Map(),
    chat: new Map(),
    activity: [],
    nextActivityId: 1,
    nextTeamMessageId: 1,
  };

  for (const entry of safeReaddir(ROOT_DIR)) {
    if (entry.startsWith(".")) continue;
    const file = companyFile(entry);
    if (!existsSync(file)) continue;
    try {
      const co = docToCompany(parseDoc(readFileSync(file, "utf8")));
      loaded.companies.set(co.id, co);

      const employees = loadPackages(
        "employee",
        agentsDir(co.id),
        (slug) => employeeFile(co.id, slug),
        (doc) => docToEmployee(doc, co.id),
      ).toSorted(byAge);
      loaded.employees.set(co.id, employees);

      const tasks = loadPackages(
        "task",
        tasksDir(co.id),
        (slug) => taskFile(co.id, slug),
        (doc) => docToTask(doc, co.id),
      ).toSorted(byAge);
      // recover runs that died with the previous process. A run that was
      // mid-flight counts as a failed attempt: requeue it (or dead-letter once
      // exhausted) so it resumes instead of being silently orphaned.
      for (const t of tasks) {
        if (t.state.kind !== "running") continue;
        const attempts = t.attempts + 1;
        if (!t.assigneeId) {
          t.state = { kind: "todo" };
        } else if (attempts >= MAX_TASK_ATTEMPTS) {
          t.state = {
            kind: "dead",
            lastError: "Interrupted by app restart (max attempts reached)",
          };
          t.attempts = attempts;
          t.completedAt = Date.now();
        } else {
          t.state = {
            kind: "queued",
            nextAttemptAt: null,
            lastError: "Interrupted by app restart",
          };
          t.attempts = attempts;
        }
        saveTask(t);
      }
      loaded.tasks.set(co.id, tasks);

      loaded.routines.set(
        co.id,
        loadPackages(
          "routine",
          routinesDir(co.id),
          (slug) => routineFile(co.id, slug),
          (doc) => docToRoutine(doc, co.id),
        ),
      );

      adoptLegacyTeam(co);
      loadRecentChat(loaded, co.id);
      loadRecentActivity(loaded, co.id);
    } catch (cause) {
      skip("company", file, cause);
    }
  }

  cache = loaded;
  lastLoad.companies = loaded.companies.size;

  // re-render every agent's AGENTS.md body so instruction-template updates
  // reach existing employees (frontmatter/persona are preserved from the file)
  for (const employees of loaded.employees.values()) {
    for (const e of employees) {
      try {
        saveEmployee(e);
      } catch {
        /* non-fatal */
      }
    }
  }

  // companies created before routines existed get the default cadence
  for (const co of loaded.companies.values()) {
    if ((loaded.routines.get(co.id) ?? []).length === 0) {
      try {
        seedDefaultRoutines(co.id, co.businessType);
      } catch {
        /* non-fatal */
      }
    }
  }

  // a company with people and no lead elects one, so the hire/release tools have an owner
  for (const co of loaded.companies.values()) {
    const emps = loaded.employees.get(co.id) ?? [];
    if (emps.length > 0 && !emps.some((e) => e.id === co.leaderId)) {
      const led = { ...co, leaderId: pickLeaderId(emps) };
      loaded.companies.set(co.id, led);
      saveCompany(led);
    }
  }
  return lastLoad;
}

/**
 * Saves from when the room belonged to a Team folder: lift the lead into
 * COMPANY.md and the room's history into chat.jsonl, once. The old folder is
 * the founder's file to remove; nothing reads it after this.
 */
function adoptLegacyTeam(co: Company): void {
  const dir = legacyTeamsDir(co.id);
  const slugs = safeReaddir(dir);
  if (slugs.length === 0) return;
  if (!existsSync(chatFile(co.id))) {
    const rows: z.infer<typeof PersistedTeamMessageSchema>[] = [];
    for (const slug of slugs) {
      rows.push(
        ...readJsonlTail(join(dir, slug, "chat.jsonl"), PersistedTeamMessageSchema, 10_000),
      );
    }
    if (rows.length > 0) {
      atomicWrite(
        chatFile(co.id),
        rows
          .toSorted((a, b) => a.createdAt - b.createdAt)
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
    }
  }
  if (co.leaderId === null) {
    for (const slug of slugs) {
      const file = join(dir, slug, "TEAM.md");
      if (!existsSync(file)) continue;
      try {
        const lead = optStr(parseDoc(readFileSync(file, "utf8")).metadata, "leaderId");
        if (lead !== null) {
          co.leaderId = lead;
          saveCompany(co);
          return;
        }
      } catch {
        /* an unreadable TEAM.md has nothing to adopt */
      }
    }
  }
}

const LEADER_RX = /(ceo|founder|chief|head|lead|manager|principal|director|\bpm\b|product)/i;

/** Heuristic leader pick: a managerial role/title, else the first hire. */
function pickLeaderId(emps: Employee[]): string | null {
  const byRole = emps.find((e) => LEADER_RX.test(`${e.role} ${e.title}`));
  return (byRole ?? emps[0])?.id ?? null;
}

/** The lead the roster elects: a managerial role or title, else the first hire. */
const electLead = (companyId: string): string | null => pickLeaderId(listEmployees(companyId));

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function loadRecentActivity(loaded: Cache, companyId: string): void {
  const rows = readJsonlTail(activityFile(companyId), PersistedActivitySchema, ACTIVITY_RING);
  for (const row of rows) loaded.activity.push({ ...row, id: loaded.nextActivityId++ });
  if (loaded.activity.length > ACTIVITY_RING)
    loaded.activity = loaded.activity.slice(-ACTIVITY_RING);
}

const TEAM_CHAT_RING = 200;

// One chat.jsonl line, as postTeamMessage persists it (id and companyId re-assigned on load).
const PersistedTeamMessageSchema = z.object({
  fromEmployeeId: z.string().nullable(),
  text: z.string(),
  createdAt: z.number(),
});

function loadRecentChat(loaded: Cache, companyId: string): void {
  const rows = readJsonlTail(chatFile(companyId), PersistedTeamMessageSchema, TEAM_CHAT_RING);
  const msgs: TeamMessage[] = [];
  for (const row of rows) msgs.push({ ...row, id: loaded.nextTeamMessageId++, companyId });
  loaded.chat.set(companyId, msgs);
}

// ---- slug allocation ---------------------------------------------------------
/**
 * The slug for a new package: the name's slug, suffixed past the highest one
 * already used. One pass over what exists — autopilot titles repeat for the
 * life of a company, so probing candidates one by one grew with every run.
 * `onDisk` catches a folder the cache does not know about (a package it
 * refused to load).
 */
function uniqueSlug(
  base: string,
  existing: Iterable<string>,
  onDisk: (slug: string) => boolean = () => false,
): string {
  const root = slugify(base);
  let rootTaken = false;
  let highest = 1;
  for (const id of existing) {
    if (id === root) rootTaken = true;
    else if (id.startsWith(`${root}-`)) {
      const n = Number(id.slice(root.length + 1));
      if (Number.isInteger(n) && n > highest) highest = n;
    }
  }
  if (!rootTaken && !onDisk(root)) return root;
  let candidate = `${root}-${highest + 1}`;
  while (onDisk(candidate)) candidate = `${candidate}-${Date.now().toString(36)}`;
  return candidate;
}

// ---- companies -------------------------------------------------------------
export interface FoundingHire {
  name: string;
  role: string;
  title: string;
  persona: string;
  runner: AgentRunner;
  spriteSeed: string;
}

/**
 * Found a company: the folder, its founding hires, their team and routines —
 * all of it, or none. COMPANY.md is written last, so a folder that exists is a
 * company that is whole: boot ignores a folder without one, and a founding
 * that dies midway leaves nothing the office would ever show as a company.
 */
export function foundCompany(input: {
  name: string;
  mission: string;
  businessType: BusinessTypeId;
  founderName: string;
  founderSpriteSeed: string;
  budget: Budget;
  hires: readonly FoundingHire[];
}): Company {
  const id = uniqueSlug(input.name, c().companies.keys(), (s) => existsSync(companyDir(s)));
  const co: Company = {
    id,
    name: input.name,
    mission: input.mission,
    businessType: input.businessType,
    workspaceDir: companyWorkspace(id),
    founderName: input.founderName,
    founderSpriteSeed: input.founderSpriteSeed,
    autopilot: true,
    maxAgents: DEFAULT_MAX_AGENTS,
    leaderId: null,
    ships: 0,
    revenueUsd: null,
    users: null,
    budget: input.budget,
    spentUsd: 0,
    createdAt: Date.now(),
  };
  c().companies.set(id, co);
  c().employees.set(id, []);
  c().tasks.set(id, []);
  c().routines.set(id, []);
  c().chat.set(id, []);
  try {
    mkdirSync(companyWorkspace(id), { recursive: true });
    mkdirSync(tasksDir(id), { recursive: true });
    mkdirSync(agentsDir(id), { recursive: true });
    input.hires.forEach((hire, deskIndex) => createEmployee({ companyId: id, deskIndex, ...hire }));
    co.leaderId = electLead(id);
    seedDefaultRoutines(id, input.businessType);
    saveCompany(co);
  } catch (cause) {
    for (const map of [c().companies, c().employees, c().tasks, c().routines, c().chat])
      map.delete(id);
    rmSync(companyDir(id), { recursive: true, force: true });
    throw cause;
  }
  return co;
}

/** Every new company starts with a real operating cadence (+ one per business type). */
function seedDefaultRoutines(companyId: string, businessType: BusinessTypeId): void {
  createRoutine({
    companyId,
    name: "Business review",
    intervalHours: 24,
    role: null,
    instruction:
      "Step back and review the business: recent ships, team chat, and the product's current state. Identify the single weakest area (product, marketing, or distribution) and either fix it now or delegate it to the right teammate.",
  });
  createRoutine({
    companyId,
    name: "Marketing push",
    intervalHours: 48,
    role: "market",
    instruction:
      "Produce one real piece of marketing for the product as it exists today: a launch/update post, landing copy, or outreach draft. Make it concrete and ready to publish. Ask the founder via ask_boss before posting anywhere public.",
  });
  const preset = businessTypeById(businessType).routine;
  if (preset) {
    createRoutine({
      companyId,
      name: preset.name,
      intervalHours: preset.intervalHours,
      role: preset.role,
      instruction: preset.instruction,
    });
  }
}

function createRoutine(input: {
  companyId: string;
  name: string;
  instruction: string;
  intervalHours: number;
  role: string | null;
}): Routine {
  const list = c().routines.get(input.companyId);
  if (!list) throw new Error(`company ${input.companyId} not found`);
  const id = uniqueSlug(
    input.name,
    list.map((r) => r.id),
  );
  const routine: Routine = {
    id,
    companyId: input.companyId,
    name: input.name,
    instruction: input.instruction,
    intervalHours: input.intervalHours,
    role: input.role,
    lastRunAt: null,
  };
  saveRoutine(routine);
  list.push(routine);
  return routine;
}

export function listRoutines(companyId: string): Routine[] {
  return [...(c().routines.get(companyId) ?? [])];
}

export function markRoutineRun(companyId: string, routineId: string): void {
  const list = c().routines.get(companyId);
  const r = list?.find((x) => x.id === routineId);
  if (!r) return;
  r.lastRunAt = Date.now();
  saveRoutine(r);
}

// ---- teams -----------------------------------------------------------------
/**
 * Release an employee: archive their package to alumni/ (memory + history
 * preserved, never deleted), prune them from their team, and orphan their
 * open tasks so nothing keeps scheduling them.
 */
export function archiveEmployee(employeeId: string): Employee | null {
  const emp = getEmployee(employeeId);
  if (!emp) return null;
  const companyTasks = c().tasks.get(emp.companyId) ?? [];
  for (const t of companyTasks) {
    if (t.assigneeId === employeeId && (t.state.kind === "todo" || t.state.kind === "queued")) {
      const next: Task = { ...t, assigneeId: null };
      companyTasks[companyTasks.indexOf(t)] = next;
      saveTask(next);
    }
  }
  const list = c().employees.get(emp.companyId);
  if (list) {
    const idx = list.findIndex((e) => e.id === employeeId);
    if (idx >= 0) list.splice(idx, 1);
  }
  try {
    mkdirSync(alumniDir(emp.companyId), { recursive: true });
    renameSync(
      employeeAgentDir(emp.companyId, employeeId),
      join(alumniDir(emp.companyId), employeeId),
    );
  } catch {
    /* archive is best-effort — the roster removal is what matters */
  }
  // the lead left: whoever remains elects one, so the tools keep an owner
  const company = getCompany(emp.companyId);
  if (company?.leaderId === employeeId) {
    patchCompany(company.id, { leaderId: electLead(company.id) });
  }
  return emp;
}

// ---- the company room ------------------------------------------------------
/** Post a message to the company's persistent room (read by teammates mid-run). */
export function postTeamMessage(
  companyId: string,
  fromEmployeeId: string | null,
  text: string,
): TeamMessage {
  const msg: TeamMessage = { companyId, fromEmployeeId, text, createdAt: Date.now() };
  const ring = c().chat.get(companyId) ?? [];
  const stored: TeamMessage = { ...msg, id: c().nextTeamMessageId++ };
  ring.push(stored);
  if (ring.length > TEAM_CHAT_RING) ring.splice(0, ring.length - TEAM_CHAT_RING);
  c().chat.set(companyId, ring);
  appendJsonl(chatFile(companyId), msg);
  return stored;
}

/** Recent room messages, optionally only those after a given timestamp. */
export function recentTeamMessages(companyId: string, limit = 20, since = 0): TeamMessage[] {
  const ring = c().chat.get(companyId) ?? [];
  const filtered = since > 0 ? ring.filter((m) => m.createdAt > since) : ring;
  return filtered.slice(-limit);
}

export function getCompany(id: string): Company | null {
  return c().companies.get(id) ?? null;
}

/** The company an IPC call names; the renderer only ever holds real ids. */
export function requireCompany(id: string): Company {
  const company = getCompany(id);
  if (!company) throw new Error(`company ${id} not found`);
  return company;
}

export function getDefaultCompany(): Company | null {
  let latest: Company | null = null;
  for (const co of c().companies.values()) {
    if (!latest || co.createdAt > latest.createdAt) latest = co;
  }
  return latest;
}

function patchCompany(id: string, patch: Partial<Company>): Company {
  const co = c().companies.get(id);
  if (!co) throw new Error(`company ${id} not found`);
  const next = { ...co, ...patch, id: co.id };
  c().companies.set(id, next);
  saveCompany(next);
  return next;
}

export function setMaxAgents(id: string, maxAgents: number): Company {
  return patchCompany(id, { maxAgents: Math.max(1, Math.round(maxAgents)) });
}
export function setAutopilot(id: string, on: boolean): Company {
  return patchCompany(id, { autopilot: on });
}
/** Record one shipped unit of work (the real counter behind the version string). */
export function recordShip(id: string): void {
  const co = c().companies.get(id);
  if (!co) return;
  patchCompany(id, { ships: co.ships + 1 });
}
// ---- founder approvals -------------------------------------------------------
// A command the founder signed off but the agent has not run yet. Persisted
// because the gap between clicking Approve and the agent's retry can span a
// restart — losing it there means being asked the same question twice.
//
// Single-use, matching what the approval card promises: approving covers that
// one command, once. A second deploy is a second real-world act and gets asked
// again rather than riding on the first yes.

// no file yet, or unreadable — nothing is approved
const readApprovals = (companyId: string): string[] =>
  readJsonFile(approvalsFile(companyId), z.array(z.string())) ?? [];

export function grantApproval(companyId: string, key: string): void {
  const keys = readApprovals(companyId);
  if (keys.includes(key)) return;
  atomicWrite(approvalsFile(companyId), JSON.stringify([...keys, key], null, 2));
}

/** Spend the approval if it is there. True means the command may run now. */
export function consumeApproval(companyId: string, key: string): boolean {
  const keys = readApprovals(companyId);
  if (!keys.includes(key)) return false;
  atomicWrite(
    approvalsFile(companyId),
    JSON.stringify(
      keys.filter((k) => k !== key),
      null,
      2,
    ),
  );
  return true;
}

/** Accumulate real AI spend (USD) from a finished run. */
export function recordSpend(id: string, costUsd: number): Company | null {
  const co = c().companies.get(id);
  if (!co) return null;
  const spent = Math.round((co.spentUsd + Math.max(0, costUsd)) * 10_000) / 10_000;
  return patchCompany(id, { spentUsd: spent });
}
export function setBudget(id: string, budget: Budget): Company {
  return patchCompany(id, { budget });
}
/** Founder zeroes the spend meter (budget unchanged). */
export function resetSpend(id: string): Company {
  return patchCompany(id, { spentUsd: 0 });
}
/** Overwrite with REAL absolute numbers from configured metrics sources.
 * Null fields are skipped (a provider hiccup keeps the last-known value). */
export function setRealMetrics(
  id: string,
  snapshot: { users: number | null; revenue: number | null },
): Company | null {
  const co = c().companies.get(id);
  if (!co) return null;
  const patch: Partial<Company> = {};
  if (snapshot.users !== null) patch.users = Math.max(0, Math.round(snapshot.users));
  if (snapshot.revenue !== null) patch.revenueUsd = Math.round(snapshot.revenue * 100) / 100;
  if (Object.keys(patch).length === 0) return co;
  return patchCompany(id, patch);
}

// ---- employees -------------------------------------------------------------
export function createEmployee(input: {
  companyId: string;
  name: string;
  role: string;
  title: string;
  persona: string;
  runner: AgentRunner;
  spriteSeed: string;
  deskIndex: number;
}): Employee {
  const list = c().employees.get(input.companyId);
  if (!list) throw new Error(`company ${input.companyId} not found`);
  // the seat cap is a domain invariant — every hire path hits it here
  const company = c().companies.get(input.companyId);
  if (company && list.length >= company.maxAgents) {
    throw new Error(`the office is at its ${company.maxAgents}-seat cap`);
  }
  const id = uniqueSlug(
    input.name,
    list.map((e) => e.id),
    (s) => existsSync(employeeAgentDir(input.companyId, s)),
  );
  const e: Employee = {
    id,
    companyId: input.companyId,
    name: input.name,
    role: input.role,
    title: input.title,
    persona: input.persona,
    runner: input.runner,
    sessionId: null,
    spriteSeed: input.spriteSeed,
    deskIndex: input.deskIndex,
    status: "idle",
    createdAt: Date.now(),
  };
  mkdirSync(employeeMemoryDir(input.companyId, id), { recursive: true });
  mkdirSync(employeeSessionDir(input.companyId, id), { recursive: true });
  saveEmployee(e);
  list.push(e);
  return e;
}

export const getEmployee = (id: string): Employee | null => findIn(c().employees, id);

/** The rendered AGENTS.md body — what a run injects as the agent's instructions. */
export function employeeInstructions(employeeId: string): string {
  const e = getEmployee(employeeId);
  if (!e) throw new Error(`employee ${employeeId} not found`);
  const co = c().companies.get(e.companyId);
  if (!co) throw new Error(`company ${e.companyId} not found`);
  return employeeBody(e, co);
}

export function listEmployees(companyId: string): Employee[] {
  return [...(c().employees.get(companyId) ?? [])];
}

function patchEmployee(id: string, patch: Partial<Employee>): void {
  patchIn(c().employees, id, patch, saveEmployee);
}

/** A run started or settled. Memory only: a fresh boot has no live runs, so disk would only lie. */
export function setEmployeeStatus(id: string, status: Employee["status"]): void {
  const emp = getEmployee(id);
  if (emp) emp.status = status;
}
export function setEmployeeSession(id: string, sessionId: string | null): void {
  patchEmployee(id, { sessionId });
}

// ---- tasks -----------------------------------------------------------------
export function createTask(t: {
  companyId: string;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  assigneeId?: string | null;
}): Task {
  const list = c().tasks.get(t.companyId);
  if (!list) throw new Error(`company ${t.companyId} not found`);
  const id = uniqueSlug(
    t.title,
    list.map((x) => x.id),
    (s) => existsSync(join(tasksDir(t.companyId), s)),
  );
  const task: Task = {
    id,
    companyId: t.companyId,
    title: t.title,
    description: t.description ?? null,
    state: { kind: "todo" },
    priority: t.priority ?? "medium",
    assigneeId: t.assigneeId ?? null,
    artifacts: [],
    attempts: 0,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
  };
  saveTask(task);
  list.push(task);
  return task;
}

export const getTask = (id: string): Task | null => findIn(c().tasks, id);

export function listTasks(companyId: string): Task[] {
  return (c().tasks.get(companyId) ?? []).toSorted((a, b) => b.createdAt - a.createdAt);
}

export function listTasksForEmployee(employeeId: string): Task[] {
  const out: Task[] = [];
  for (const list of c().tasks.values())
    for (const t of list) if (t.assigneeId === employeeId) out.push(t);
  return out.toSorted((a, b) => b.createdAt - a.createdAt);
}

const TASK_PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } satisfies Record<TaskPriority, number>;

/** Queued tasks eligible to start now (a backoff retry waits for nextAttemptAt). */
export function listQueuedTasks(): Task[] {
  const now = Date.now();
  const out: Task[] = [];
  for (const list of c().tasks.values())
    for (const t of list) {
      const st = t.state;
      if (st.kind === "queued" && (st.nextAttemptAt === null || st.nextAttemptAt <= now))
        out.push(t);
    }
  return out.toSorted(
    (a, b) =>
      TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority] ||
      a.createdAt - b.createdAt,
  );
}

const patchTask = (id: string, patch: Partial<Task>): Task | null =>
  patchIn(c().tasks, id, patch, saveTask);

/** The task's run, when the given run is the one holding its lock. */
const heldBy = (t: Task | null, runId: string): Task | null =>
  t && t.state.kind === "running" && t.state.runId === runId ? t : null;

/**
 * Atomic assign: only todo/blocked/dead are claimable. A manual claim of a
 * dead task is the founder reviving it, so the retry counter resets.
 * Returns task or null on conflict.
 */
export function claimTask(taskId: string, employeeId: string): Task | null {
  const t = getTask(taskId);
  if (!t) return null;
  const kind = t.state.kind;
  const claimable = kind === "todo" || kind === "blocked" || kind === "dead";
  if (!claimable || (t.assigneeId !== null && t.assigneeId !== employeeId)) return null;
  const patch: Partial<Task> = {
    assigneeId: employeeId,
    state: { kind: "queued", nextAttemptAt: null, lastError: null },
  };
  if (kind === "dead") patch.attempts = 0;
  return patchTask(taskId, patch);
}

/** Acquire execution lock: queued -> running, stamp runId. Null if lost race or backing off. */
export function lockTaskForRun(taskId: string, runId: string): Task | null {
  const t = getTask(taskId);
  if (!t || t.state.kind !== "queued") return null;
  if (t.state.nextAttemptAt !== null && t.state.nextAttemptAt > Date.now()) return null;
  return patchTask(taskId, { state: { kind: "running", runId }, startedAt: Date.now() });
}

/** The run settled: the task is done, or waits on the founder. Only the owning run may. */
export function settleTask(
  taskId: string,
  runId: string,
  state: Extract<TaskState, { kind: "done" | "blocked" }>,
): void {
  if (!heldBy(getTask(taskId), runId)) return;
  patchTask(taskId, { state, completedAt: Date.now() });
}

/**
 * A failed run that still has attempts left: bump the counter, schedule a
 * backoff retry, and put the task back on the queue. Only the owning run may.
 */
export function requeueForRetry(
  taskId: string,
  runId: string,
  attempts: number,
  nextAttemptAt: number,
  lastError: string,
): void {
  if (!heldBy(getTask(taskId), runId)) return;
  patchTask(taskId, { state: { kind: "queued", nextAttemptAt, lastError }, attempts });
}

/** A failed run that exhausted its attempts: dead-letter it. Only the owning run may. */
export function deadLetterTask(
  taskId: string,
  runId: string,
  attempts: number,
  lastError: string,
): void {
  if (!heldBy(getTask(taskId), runId)) return;
  patchTask(taskId, { state: { kind: "dead", lastError }, attempts, completedAt: Date.now() });
}

/**
 * The founder answers a blocked task's question: the blocked task closes and a
 * continuation task (same employee, same session → full context) is created.
 * Returns the continuation, or null if the task wasn't awaiting an answer.
 */
export function resolveBlockedWithAnswer(taskId: string, answer: string): Task | null {
  const t = getTask(taskId);
  if (!t || t.state.kind !== "blocked" || !t.assigneeId) return null;
  const { ask } = t.state;
  patchTask(taskId, {
    state: { kind: "done", summary: answeredSummary(answer) },
    completedAt: Date.now(),
  });
  return createTask({
    companyId: t.companyId,
    ...continuationBrief(t, ask, answer),
    priority: "high",
    assigneeId: t.assigneeId,
  });
}

// ---- activity log ----------------------------------------------------------
/** Stamp an id, keep it in the ring, and append it to the owning company's activity.jsonl. */
export function logActivity(row: PersistedActivity, persist: boolean): ActivityEvent {
  const entry: ActivityEvent = { ...row, id: c().nextActivityId++ };
  if (!persist) return entry;
  c().activity.push(entry);
  if (c().activity.length > ACTIVITY_RING) c().activity = c().activity.slice(-ACTIVITY_RING);

  // employee → their company, else the default company
  const companyId = row.employeeId
    ? getEmployee(row.employeeId)?.companyId
    : getDefaultCompany()?.id;
  if (companyId) appendJsonl(activityFile(companyId), row);
  return entry;
}

const ofKind =
  <K extends ActivityKind>(kind: K) =>
  (e: ActivityEvent): e is Extract<ActivityEvent, { kind: K }> =>
    e.kind === kind;

/** Recent activity rows of a kind for a company. */
export function recentActivity<K extends ActivityKind>(
  companyId: string,
  kind: K,
  limit = 12,
): Extract<ActivityEvent, { kind: K }>[] {
  const ids = new Set(listEmployees(companyId).map((e) => e.id));
  return c()
    .activity.filter(ofKind(kind))
    .filter((e) => e.employeeId != null && ids.has(e.employeeId))
    .slice(-limit);
}
