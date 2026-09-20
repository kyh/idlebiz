import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { appendJsonl, atomicWrite, moveDir, readJsonFile, readJsonlTail } from "@/main/lib/fs";
import {
  ROOT_DIR,
  ensureAppDirs,
  companyDir,
  companyFile,
  companyWorkspace,
  activityFile,
  recentShipsFile,
  sinceLastLookFile,
  agentsDir,
  approvalsFile,
  alumniDir,
  employeeAgentDir,
  employeeFile,
  employeeRunStateFile,
  employeeMemoryDir,
  employeeSessionDir,
  tasksDir,
  taskFile,
  shippedDir,
  shippedTaskFile,
  productsDir,
  productFile,
  productWorkspace,
  retiredDir,
  betsDir,
  betFile,
  policyFile,
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
} from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";
import { z } from "zod";
import { answeredSummary, continuationBrief } from "@/main/prompts/briefs";
import { standingInstructions } from "@/main/prompts/instructions";
import { RETIRED_ROUTINES, defaultRoutines } from "@/main/prompts/routines";
import type { RoutineDefinition } from "@/main/prompts/routines";
import { betToDoc, docToBet } from "@/main/store/bet-codec";
import { docToProduct, productToDoc } from "@/main/store/product-codec";
import { docToTask, taskToDoc } from "@/main/store/task-codec";
import { readMetricsConfig, writeMetricsConfig } from "@/main/metrics";
import { DEFAULT_POLICY, PolicyParamsSchema, dream, isClosed, judge } from "@/shared/bets";
import type { Bet, BetMetric, PolicyParams } from "@/shared/bets";
import { errorMessage } from "@/shared/errors";
import { emptyDigest, foldDigest } from "@/main/store/digest";
import { DigestSchema } from "@/shared/ipc-registry";
import type { Digest, LoadReport, LoadSkip } from "@/shared/ipc-registry";
import { isRunnerId } from "@repo/agent-driver/runner";
import {
  BUSINESS_TYPES,
  DEFAULT_FOUNDER_SEED,
  DEFAULT_MAX_AGENTS,
  RunMetricsSchema,
  afterFailure,
  leadOf,
} from "@/shared/domain";
import type { ActivityEvent, PersistedActivity } from "@/shared/activity";
import type {
  AgentRunner,
  FailureVerdict,
  Product,
  TaskState,
  VercelBinding,
  Budget,
  BusinessTypeId,
  Company,
  Employee,
  Routine,
  Task,
  TaskPriority,
  TeamMessage,
} from "@/shared/domain";

// Synchronous cache mutations make check-and-set atomic in the main process.
// Markdown writes use tmp+rename; activity and chat use append-only JSONL logs.

interface ActiveCompany {
  company: Company;
  employees: Employee[];
  tasks: Task[];
  // Loaded only when the shipping log is opened.
  shipped: Task[] | null;
  products: Product[];
  bets: Bet[];
  /** How the allocator weighs bets; retuned whenever one closes. */
  policy: PolicyParams;
  routines: Routine[];
  chat: TeamMessage[];
  /** The latest ship summaries, oldest first: what the next brief calls "recently shipped". */
  recentShips: string[];
  /** What has happened since the founder last looked. Null until they first do, so founding a company is not news. */
  sinceLastLook: Digest | null;
}

interface Cache {
  active: ActiveCompany | null;
  nextActivityId: number;
  nextTeamMessageId: number;
}

let cache: Cache | null = null;

const c = (): Cache => {
  if (!cache) {
    throw new Error("store not initialized");
  }
  return cache;
};

const nextId = (counter: "nextActivityId" | "nextTeamMessageId"): number => {
  const id = c()[counter];
  c()[counter] = id + 1;
  return id;
};

const activeCompany = (companyId: string): ActiveCompany | null => {
  const { active } = c();
  return active?.company.id === companyId ? active : null;
};

const requireActiveCompany = (companyId: string): ActiveCompany => {
  const active = activeCompany(companyId);
  if (!active) {
    throw new Error(`company ${companyId} is not active`);
  }
  return active;
};

const emptyCompany = (company: Company): ActiveCompany => ({
  bets: [],
  chat: [],
  company,
  employees: [],
  policy: DEFAULT_POLICY,
  products: [],
  recentShips: [],
  routines: [],
  shipped: null,
  sinceLastLook: null,
  tasks: [],
});

interface Owned {
  id: string;
  companyId: string;
}

const patchIn = <T extends Owned>(
  list: T[],
  id: string,
  patch: Partial<T>,
  save: (row: T) => void,
): T | null => {
  const idx = list.findIndex((row) => row.id === id);
  const cur = list[idx];
  if (!cur) {
    return null;
  }
  const next = { ...cur, ...patch, companyId: cur.companyId, id: cur.id };
  list[idx] = next;
  save(next);
  return next;
};

// ---- serialization ----------------------------------------------------------
const companyToDoc = (co: Company): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    autopilot: co.autopilot,
    businessType: co.businessType,
    founderName: co.founderName,
    founderSpriteSeed: co.founderSpriteSeed,
    maxAgents: co.maxAgents,
    ships: co.ships,
  };
  if (co.leaderId !== null) {
    metadata.leaderId = co.leaderId;
  }
  // real metrics: absent keys mean "no source has ever reported"
  if (co.revenueUsd !== null) {
    metadata.revenueUsd = co.revenueUsd;
  }
  if (co.users !== null) {
    metadata.users = co.users;
  }
  metadata.budgetMode = co.budget.mode;
  if (co.budget.mode === "capped") {
    metadata.budgetCapUsd = co.budget.capUsd;
  }
  metadata.spentUsd = co.spentUsd;
  metadata.createdAt = co.createdAt;
  return {
    body: `# ${co.name}\n\n${co.mission}\n`,
    fields: {
      description: co.mission,
      kind: "company",
      name: co.name,
      schema: "agentcompanies/v1",
      slug: co.id,
    },
    metadata,
  };
};

const parseBusinessType = (raw: string | null): BusinessTypeId => {
  const found = BUSINESS_TYPES.find((b) => b.id === raw);
  return found ? found.id : "custom";
};

const parseBudget = (m: FrontmatterDoc["metadata"]): Budget => {
  if (optStr(m, "budgetMode") === "capped") {
    return { capUsd: Math.max(0, optNum(m, "budgetCapUsd", 0)), mode: "capped" };
  }
  return { mode: "infinite" };
};

const docToCompany = (doc: FrontmatterDoc): Company => {
  const f = doc.fields;
  const m = doc.metadata;
  const id = reqStr(f, "slug");
  return {
    autopilot: optBool(m, "autopilot", true),
    budget: parseBudget(m),
    businessType: parseBusinessType(optStr(m, "businessType")),
    createdAt: reqNum(m, "createdAt"),
    founderName: optStr(m, "founderName") ?? "Founder",
    founderSpriteSeed: optStr(m, "founderSpriteSeed") ?? DEFAULT_FOUNDER_SEED,
    id,
    leaderId: optStr(m, "leaderId"),
    maxAgents: Math.max(1, optNum(m, "maxAgents", DEFAULT_MAX_AGENTS)),
    mission: optStr(f, "description") ?? "",
    name: reqStr(f, "name"),
    revenueUsd: nullableNum(m, "revenueUsd"),
    ships: optNum(m, "ships", 0),
    spentUsd: Math.max(0, optNum(m, "spentUsd", 0)),
    users: nullableNum(m, "users"),
    workspaceDir: companyWorkspace(id),
  };
};

const parseRunner = (v: string | null): AgentRunner => (v && isRunnerId(v) ? v : "codex");

const employeeBody = (e: Employee, co: Company, products: readonly Product[]): string =>
  standingInstructions({
    company: co,
    employee: e,
    lead: co.leaderId === e.id,
    memoryDir: employeeMemoryDir(co.id, e.id),
    products,
  });

const employeeToDoc = (e: Employee, co: Company, products: readonly Product[]): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    createdAt: e.createdAt,
    deskIndex: e.deskIndex,
    persona: e.persona,
    role: e.role,
    runner: e.runner,
    spriteSeed: e.spriteSeed,
    title: e.title,
  };
  return {
    body: employeeBody(e, co, products),
    fields: {
      description: e.title || e.role,
      kind: "agent",
      name: e.name,
      schema: "agentcompanies/v1",
      slug: e.id,
    },
    metadata,
  };
};

/** What a run leaves for the next one; kept out of AGENTS.md so the instructions only change when they do. */
const RunStateSchema = z.object({
  lastRunMetrics: RunMetricsSchema.nullable(),
  sessionId: z.string().nullable(),
});

const saveRunState = (e: Employee): void => {
  const state: z.infer<typeof RunStateSchema> = {
    lastRunMetrics: e.lastRunMetrics,
    sessionId: e.sessionId,
  };
  atomicWrite(employeeRunStateFile(e.companyId, e.id), JSON.stringify(state, null, 2));
};

const withRunState = (e: Employee): Employee => ({
  ...e,
  ...readJsonFile(employeeRunStateFile(e.companyId, e.id), RunStateSchema),
});

const docToEmployee = (doc: FrontmatterDoc, companyId: string): Employee => {
  const f = doc.fields;
  const m = doc.metadata;
  return {
    companyId,
    createdAt: optNum(m, "createdAt", Date.now()),
    deskIndex: optNum(m, "deskIndex", 0),
    id: reqStr(f, "slug"),
    lastRunMetrics: null,
    name: reqStr(f, "name"),
    persona: optStr(m, "persona") ?? "",
    role: optStr(m, "role") ?? "general",
    runner: parseRunner(optStr(m, "runner")),
    // saves from before run-state.json kept the session here; withRunState prefers the file
    sessionId: optStr(m, "sessionId"),
    spriteSeed: optStr(m, "spriteSeed") ?? `emp-${reqStr(f, "slug")}`,
    status: "idle",
    title: optStr(m, "title") ?? optStr(f, "description") ?? "",
  };
};

const routineToDoc = (r: Routine): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = { intervalHours: r.intervalHours };
  if (r.role !== null) {
    metadata.role = r.role;
  }
  if (r.lastRunAt !== null) {
    metadata.lastRunAt = r.lastRunAt;
  }
  return {
    body: `${r.instruction}\n`,
    fields: { name: r.name, schema: "agentcompanies/v1", slug: r.id },
    metadata,
  };
};

const docToRoutine = (doc: FrontmatterDoc, companyId: string): Routine => ({
  companyId,
  id: reqStr(doc.fields, "slug"),
  instruction: doc.body.trim(),
  intervalHours: optNum(doc.metadata, "intervalHours", 24),
  lastRunAt: nullableNum(doc.metadata, "lastRunAt"),
  name: reqStr(doc.fields, "name"),
  role: optStr(doc.metadata, "role"),
});

// ---- persistence ------------------------------------------------------------
const readTextIfPresent = (file: string): string | null => {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
};

const saveCompany = (co: Company): void => {
  atomicWrite(companyFile(co.id), serializeDoc(companyToDoc(co)));
};

const saveEmployee = (e: Employee, opts: { onlyIfChanged?: boolean } = {}): void => {
  const { company, products } = requireActiveCompany(e.companyId);
  const file = employeeFile(e.companyId, e.id);
  const text = serializeDoc(employeeToDoc(e, company, products));
  if (opts.onlyIfChanged && readTextIfPresent(file) === text) {
    return;
  }
  atomicWrite(file, text);
};

const saveTask = (t: Task): void => {
  atomicWrite(taskFile(t.companyId, t.id), serializeDoc(taskToDoc(t)));
};

const saveProduct = (p: Product): void => {
  atomicWrite(productFile(p.companyId, p.id), serializeDoc(productToDoc(p)));
};

const saveBet = (b: Bet): void => {
  atomicWrite(betFile(b.companyId, b.id), serializeDoc(betToDoc(b)));
};

const saveRoutine = (r: Routine): void => {
  atomicWrite(routineFile(r.companyId, r.id), serializeDoc(routineToDoc(r)));
};

const shelve = (t: Task): void => {
  moveDir(path.join(tasksDir(t.companyId), t.id), path.join(shippedDir(t.companyId), t.id));
};

// ---- slug allocation ---------------------------------------------------------
/** Scan suffixes once; onDisk also protects packages skipped during loading. */
const uniqueSlug = (
  base: string,
  existing: Iterable<string>,
  onDisk: (slug: string) => boolean = () => false,
): string => {
  const root = slugify(base);
  let rootTaken = false;
  let highest = 1;
  for (const id of existing) {
    if (id === root) {
      rootTaken = true;
    } else if (id.startsWith(`${root}-`)) {
      const n = Number(id.slice(root.length + 1));
      if (Number.isInteger(n) && n > highest) {
        highest = n;
      }
    }
  }
  if (!rootTaken && !onDisk(root)) {
    return root;
  }
  let candidate = `${root}-${highest + 1}`;
  while (onDisk(candidate)) {
    candidate = `${candidate}-${Date.now().toString(36)}`;
  }
  return candidate;
};

// ---- loading ----------------------------------------------------------------
/** Oldest first; ties (same millisecond) by id, so boot order is stable. */
const byAge = <T extends { createdAt: number; id: string }>(a: T, b: T): number =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

// Failed company loads must surface in the UI instead of presenting onboarding over a save.
let lastLoad: LoadReport = { companies: 0, skipped: [] };

export const loadReport = (): LoadReport => lastLoad;

const skip = (kind: LoadSkip["kind"], file: string, cause: unknown): void => {
  lastLoad.skipped.push({ error: errorMessage(cause), kind, path: file });
};

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Report corrupt packages individually so one hand-edited file cannot prevent loading. */
const loadPackages = <T extends { id: string }>(
  kind: LoadSkip["kind"],
  dir: string,
  fileFor: (slug: string) => string,
  decode: (doc: FrontmatterDoc) => T,
): T[] => {
  const rows: T[] = [];
  for (const slug of safeReaddir(dir)) {
    const file = fileFor(slug);
    if (!existsSync(file)) {
      continue;
    }
    try {
      const row = decode(parseDoc(readFileSync(file, "utf-8")));
      if (row.id !== slug) {
        throw new Error("package slug does not match its directory");
      }
      rows.push(row);
    } catch (error) {
      skip(kind, file, error);
    }
  }
  return rows;
};

const TEAM_CHAT_RING = 200;

// One chat.jsonl line, as postTeamMessage persists it (id and companyId re-assigned on load).
const PersistedTeamMessageSchema = z.object({
  createdAt: z.number(),
  fromEmployeeId: z.string().nullable(),
  text: z.string(),
});

const loadRecentChat = (active: ActiveCompany): void => {
  const companyId = active.company.id;
  const rows = readJsonlTail(chatFile(companyId), PersistedTeamMessageSchema, TEAM_CHAT_RING);
  for (const row of rows) {
    active.chat.push({ ...row, companyId, id: nextId("nextTeamMessageId") });
  }
};

/** Adopt legacy team leadership and chat without deleting the original files. */
const adoptLegacyTeam = (co: Company): void => {
  const dir = legacyTeamsDir(co.id);
  const slugs = safeReaddir(dir);
  if (slugs.length === 0) {
    return;
  }
  if (!existsSync(chatFile(co.id))) {
    const rows: z.infer<typeof PersistedTeamMessageSchema>[] = [];
    for (const slug of slugs) {
      rows.push(
        ...readJsonlTail(path.join(dir, slug, "chat.jsonl"), PersistedTeamMessageSchema, 10_000),
      );
    }
    if (rows.length > 0) {
      atomicWrite(
        chatFile(co.id),
        `${rows
          .toSorted((a, b) => a.createdAt - b.createdAt)
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
      );
    }
  }
  if (co.leaderId === null) {
    for (const slug of slugs) {
      const file = path.join(dir, slug, "TEAM.md");
      if (!existsSync(file)) {
        continue;
      }
      try {
        const lead = optStr(parseDoc(readFileSync(file, "utf-8")).metadata, "leaderId");
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
};

// ---- companies -------------------------------------------------------------
export const getCompany = (id: string): Company | null => activeCompany(id)?.company ?? null;

export const requireCompany = (id: string): Company => {
  const company = getCompany(id);
  if (!company) {
    throw new Error(`company ${id} not found`);
  }
  return company;
};

export const getDefaultCompany = (): Company | null => c().active?.company ?? null;

const patchCompany = (id: string, patch: Partial<Company>): Company => {
  const active = requireActiveCompany(id);
  const co = active.company;
  const next = { ...co, ...patch, id: co.id };
  active.company = next;
  saveCompany(next);
  return next;
};

export const setMaxAgents = (id: string, maxAgents: number): Company =>
  patchCompany(id, { maxAgents: Math.max(1, Math.round(maxAgents)) });

export const setAutopilot = (id: string, on: boolean): Company =>
  patchCompany(id, { autopilot: on });

// ---- founder approvals -------------------------------------------------------
// Exact-command approvals survive restart and are consumed once.
const readApprovals = (companyId: string): string[] => {
  requireActiveCompany(companyId);
  return readJsonFile(approvalsFile(companyId), z.array(z.string())) ?? [];
};

export const grantApproval = (companyId: string, key: string): void => {
  const keys = readApprovals(companyId);
  if (keys.includes(key)) {
    return;
  }
  atomicWrite(approvalsFile(companyId), JSON.stringify([...keys, key], null, 2));
};

export const consumeApproval = (companyId: string, key: string): boolean => {
  const keys = readApprovals(companyId);
  if (!keys.includes(key)) {
    return false;
  }
  atomicWrite(
    approvalsFile(companyId),
    JSON.stringify(
      keys.filter((k) => k !== key),
      null,
      2,
    ),
  );
  return true;
};

export const recordSpend = (id: string, costUsd: number): Company | null => {
  const co = getCompany(id);
  if (!co) {
    return null;
  }
  const spent = Math.round((co.spentUsd + Math.max(0, costUsd)) * 10_000) / 10_000;
  return patchCompany(id, { spentUsd: spent });
};

export const setBudget = (id: string, budget: Budget): Company => patchCompany(id, { budget });

export const resetSpend = (id: string): Company => patchCompany(id, { spentUsd: 0 });

/** Null metrics keep the last reported value through provider failures. */
export const setRealMetrics = (
  id: string,
  snapshot: { users: number | null; revenue: number | null },
): Company | null => {
  const co = getCompany(id);
  if (!co) {
    return null;
  }
  const patch: Partial<Company> = {};
  if (snapshot.users !== null) {
    patch.users = Math.max(0, Math.round(snapshot.users));
  }
  if (snapshot.revenue !== null) {
    patch.revenueUsd = Math.round(snapshot.revenue * 100) / 100;
  }
  if (Object.keys(patch).length === 0) {
    return co;
  }
  return patchCompany(id, patch);
};

// ---- routines --------------------------------------------------------------
const routineRecord = (input: RoutineDefinition & { companyId: string }, id: string): Routine => ({
  companyId: input.companyId,
  id,
  instruction: input.instruction,
  intervalHours: input.intervalHours,
  lastRunAt: null,
  name: input.name,
  role: input.role,
});

const createRoutine = (input: RoutineDefinition & { companyId: string }): Routine => {
  const list = requireActiveCompany(input.companyId).routines;
  const id = uniqueSlug(
    input.name,
    list.map((r) => r.id),
  );
  const routine = routineRecord(input, id);
  saveRoutine(routine);
  list.push(routine);
  return routine;
};

const seedDefaultRoutines = (companyId: string, businessType: BusinessTypeId): void => {
  for (const routine of defaultRoutines(businessType)) {
    createRoutine({ companyId, ...routine });
  }
};

const dropRetiredRoutines = (active: ActiveCompany): void => {
  for (const routine of active.routines.filter((r) => RETIRED_ROUTINES.includes(r.id))) {
    active.routines.splice(active.routines.indexOf(routine), 1);
    rmSync(path.dirname(routineFile(routine.companyId, routine.id)), {
      force: true,
      recursive: true,
    });
  }
};

export const listRoutines = (companyId: string): Routine[] => [
  ...(activeCompany(companyId)?.routines ?? []),
];

export const markRoutineRun = (companyId: string, routineId: string): void => {
  const list = activeCompany(companyId)?.routines;
  const r = list?.find((x) => x.id === routineId);
  if (!r) {
    return;
  }
  r.lastRunAt = Date.now();
  saveRoutine(r);
};

// ---- employees -------------------------------------------------------------
export interface FoundingHire {
  name: string;
  role: string;
  title: string;
  persona: string;
  runner: AgentRunner;
  spriteSeed: string;
}

type EmployeeInput = FoundingHire & { companyId: string; deskIndex: number };

const employeeRecord = (input: EmployeeInput, id: string): Employee => ({
  companyId: input.companyId,
  createdAt: Date.now(),
  deskIndex: input.deskIndex,
  id,
  lastRunMetrics: null,
  name: input.name,
  persona: input.persona,
  role: input.role,
  runner: input.runner,
  sessionId: null,
  spriteSeed: input.spriteSeed,
  status: "idle",
  title: input.title,
});

export const createEmployee = (input: EmployeeInput): Employee => {
  const { company, employees: list } = requireActiveCompany(input.companyId);
  if (list.length >= company.maxAgents) {
    throw new Error(`the office is at its ${company.maxAgents}-seat cap`);
  }
  const id = uniqueSlug(
    input.name,
    list.map((e) => e.id),
    (s) => existsSync(employeeAgentDir(input.companyId, s)),
  );
  const employee = employeeRecord(input, id);
  mkdirSync(employeeMemoryDir(input.companyId, id), { recursive: true });
  mkdirSync(employeeSessionDir(input.companyId, id), { recursive: true });
  saveEmployee(employee);
  list.push(employee);
  return employee;
};

export const getEmployee = (id: string): Employee | null =>
  c().active?.employees.find((employee) => employee.id === id) ?? null;

export const employeeInstructions = (employeeId: string): string => {
  const e = getEmployee(employeeId);
  if (!e) {
    throw new Error(`employee ${employeeId} not found`);
  }
  const { company, products } = requireActiveCompany(e.companyId);
  return employeeBody(e, company, products);
};

export const listEmployees = (companyId: string): Employee[] => [
  ...(activeCompany(companyId)?.employees ?? []),
];

/** A run started or settled. Memory only: a fresh boot has no live runs, so disk would only lie. */
export const setEmployeeStatus = (id: string, status: Employee["status"]): void => {
  const emp = getEmployee(id);
  if (emp) {
    emp.status = status;
  }
};

/** A run ended: keep the session to resume and where the real numbers stood, for the next brief to measure from. */
export const noteRunEnd = (id: string, sessionId: string | null): void => {
  const { active } = c();
  if (!active) {
    return;
  }
  const { revenueUsd, users } = active.company;
  const lastRunMetrics = { at: Date.now(), revenueUsd, users };
  patchIn(active.employees, id, { lastRunMetrics, sessionId }, saveRunState);
};

/** Archive the employee package and unassign queued work. */
export const archiveEmployee = (employeeId: string): Employee | null => {
  const emp = getEmployee(employeeId);
  if (!emp) {
    return null;
  }
  const active = requireActiveCompany(emp.companyId);
  const companyTasks = active.tasks;
  for (const t of companyTasks) {
    if (t.assigneeId === employeeId && (t.state.kind === "todo" || t.state.kind === "queued")) {
      const next: Task = { ...t, assigneeId: null };
      companyTasks[companyTasks.indexOf(t)] = next;
      saveTask(next);
    }
  }
  const idx = active.employees.findIndex((e) => e.id === employeeId);
  if (idx !== -1) {
    active.employees.splice(idx, 1);
  }
  try {
    moveDir(
      employeeAgentDir(emp.companyId, employeeId),
      path.join(alumniDir(emp.companyId), employeeId),
    );
  } catch {
    /* archive is best-effort — the roster removal is what matters */
  }
  // the lead left: whoever remains elects one, so the tools keep an owner
  const company = getCompany(emp.companyId);
  if (company?.leaderId === employeeId) {
    patchCompany(company.id, { leaderId: leadOf(listEmployees(company.id)) });
  }
  return emp;
};

// ---- products --------------------------------------------------------------
/** The first product shares the company workspace and inherits its legacy metrics. */
const firstProduct = (co: Company, vercel: VercelBinding | null): Product => ({
  companyId: co.id,
  createdAt: co.createdAt,
  description: co.mission,
  id: uniqueSlug(co.name, [], (s) => existsSync(path.join(productsDir(co.id), s))),
  lastShipAt: null,
  name: co.name,
  revenueUsd: null,
  ships: co.ships,
  users: co.users,
  vercel,
  workspaceDir: co.workspaceDir,
});

export const getProduct = (id: string): Product | null =>
  c().active?.products.find((product) => product.id === id) ?? null;

export const requireProduct = (id: string): Product => {
  const p = getProduct(id);
  if (!p) {
    throw new Error(`no product ${id}`);
  }
  return p;
};

export const listProducts = (companyId: string): Product[] => [
  ...(activeCompany(companyId)?.products ?? []),
];

const patchProduct = (id: string, patch: Partial<Product>): Product | null =>
  patchIn(c().active?.products ?? [], id, patch, saveProduct);

export const createProduct = (input: {
  companyId: string;
  name: string;
  description: string;
}): Product => {
  const list = requireActiveCompany(input.companyId).products;
  const id = uniqueSlug(
    input.name,
    list.map((p) => p.id),
    (s) => existsSync(path.join(productsDir(input.companyId), s)),
  );
  const product: Product = {
    companyId: input.companyId,
    createdAt: Date.now(),
    description: input.description.trim(),
    id,
    lastShipAt: null,
    name: input.name.trim(),
    revenueUsd: null,
    ships: 0,
    users: null,
    vercel: null,
    workspaceDir: productWorkspace(input.companyId, id),
  };
  mkdirSync(product.workspaceDir, { recursive: true });
  saveProduct(product);
  list.push(product);
  for (const e of listEmployees(input.companyId)) {
    saveEmployee(e);
  }
  return product;
};

export const setProductVercel = (productId: string, vercel: VercelBinding | null): Product | null =>
  patchProduct(productId, { vercel });

/** Real numbers per product, from the pulse; a null keeps the last-known value. */
export const setProductMetrics = (
  productId: string,
  snapshot: { users: number | null; revenue: number | null },
): void => {
  const patch: Partial<Product> = {};
  if (snapshot.users !== null) {
    patch.users = Math.max(0, Math.round(snapshot.users));
  }
  if (snapshot.revenue !== null) {
    patch.revenueUsd = Math.round(snapshot.revenue * 100) / 100;
  }
  if (Object.keys(patch).length > 0) {
    patchProduct(productId, patch);
  }
};

/** Where work no bet pays for lands: the product that has waited longest for a ship. */
export const attentionProduct = (companyId: string): Product | null => {
  const products = activeCompany(companyId)?.products ?? [];
  return products.toSorted((a, b) => (a.lastShipAt ?? 0) - (b.lastShipAt ?? 0))[0] ?? null;
};

// ---- bets ------------------------------------------------------------------
export const listBets = (companyId: string): Bet[] => [...(activeCompany(companyId)?.bets ?? [])];

export const getBet = (id: string): Bet | null =>
  c().active?.bets.find((bet) => bet.id === id) ?? null;

export const allocationPolicy = (companyId: string): PolicyParams =>
  activeCompany(companyId)?.policy ?? DEFAULT_POLICY;

const patchBet = (id: string, patch: Partial<Bet>): Bet | null =>
  patchIn(c().active?.bets ?? [], id, patch, saveBet);

/** What a product's metric reads now; null while no source reports it. */
const readingOf = (product: Product | null, metric: BetMetric): number | null => {
  if (!product) {
    return null;
  }
  return metric === "users" ? product.users : product.revenueUsd;
};

/** Two live bets on one number of one product could not be told apart, so the second is refused. */
export const openBet = (input: {
  companyId: string;
  productId: string;
  title: string;
  hypothesis: string;
  metric: BetMetric;
  target: number;
  budgetUsd: number;
  windowHours: number;
}): Bet | { refused: string } => {
  const active = requireActiveCompany(input.companyId);
  const product = active.products.find((p) => p.id === input.productId);
  if (!product) {
    return {
      refused: `No product "${input.productId}" here — the products are ${active.products.map((p) => p.id).join(", ")}.`,
    };
  }
  const rival = active.bets.find(
    (b) => b.productId === product.id && b.metric === input.metric && !isClosed(b),
  );
  if (rival) {
    return {
      refused: `"${rival.title}" (${rival.id}) is already betting on ${product.name}'s ${input.metric}, and two bets on one number cannot be told apart. Work that one, bet on the other metric, or bet on another product.`,
    };
  }
  const id = uniqueSlug(
    input.title,
    active.bets.map((b) => b.id),
    (s) => existsSync(path.join(betsDir(input.companyId), s)),
  );
  const bet: Bet = {
    baseline: readingOf(product, input.metric) ?? 0,
    budgetUsd: input.budgetUsd,
    companyId: input.companyId,
    createdAt: Date.now(),
    hypothesis: input.hypothesis.trim(),
    id,
    metric: input.metric,
    productId: product.id,
    spentUsd: 0,
    state: { kind: "open" },
    target: input.target,
    title: input.title.trim(),
    windowHours: input.windowHours,
  };
  saveBet(bet);
  active.bets.push(bet);
  return bet;
};

export const recordBetSpend = (betId: string, costUsd: number): void => {
  const bet = getBet(betId);
  if (bet) {
    const spentUsd = Math.round((bet.spentUsd + Math.max(0, costUsd)) * 10_000) / 10_000;
    patchBet(betId, { spentUsd });
  }
};

const retune = (active: ActiveCompany): void => {
  const next = dream(active.policy, active.bets);
  if (next !== active.policy) {
    active.policy = next;
    atomicWrite(policyFile(active.company.id), JSON.stringify(next, null, 2));
  }
};

/** The work is shipped: stop spending and let the number answer. */
export const measureBet = (betId: string, now: number): Bet | null => {
  const bet = getBet(betId);
  if (!bet || bet.state.kind !== "open") {
    return null;
  }
  return patchBet(betId, {
    state: { kind: "measuring", until: now + bet.windowHours * 3_600_000 },
  });
};

/** The lead gives up on a bet before its window does. */
export const killBet = (betId: string, reason: string, now: number): Bet | null => {
  const bet = getBet(betId);
  if (!bet || isClosed(bet)) {
    return null;
  }
  const reading = readingOf(getProduct(bet.productId), bet.metric);
  const killed = patchBet(betId, {
    state: {
      closedAt: now,
      kind: "killed",
      moved: reading === null ? null : reading - bet.baseline,
      reason,
    },
  });
  retune(requireActiveCompany(bet.companyId));
  return killed;
};

/** Judge every live bet against the real numbers; returns the ones whose state changed. */
export const judgeBets = (companyId: string, now: number): Bet[] => {
  const active = activeCompany(companyId);
  if (!active) {
    return [];
  }
  const changed: Bet[] = [];
  for (const bet of active.bets) {
    const state = judge(bet, readingOf(getProduct(bet.productId), bet.metric), now);
    if (state !== bet.state) {
      const next = patchBet(bet.id, { state });
      if (next) {
        changed.push(next);
      }
    }
  }
  if (changed.some(isClosed)) {
    retune(active);
  }
  return changed;
};

/** How many ship summaries a brief lists. */
const RECENT_SHIPS = 6;
const RecentShipsSchema = z.array(z.string());

export const recentShips = (companyId: string): readonly string[] =>
  activeCompany(companyId)?.recentShips ?? [];

export const recordShip = (companyId: string, productId: string | null, summary: string): void => {
  const active = activeCompany(companyId);
  if (!active) {
    return;
  }
  patchCompany(companyId, { ships: active.company.ships + 1 });
  const product = productId === null ? null : getProduct(productId);
  if (product) {
    patchProduct(product.id, { lastShipAt: Date.now(), ships: product.ships + 1 });
  }
  // the counters are the record; the brief's list follows them
  active.recentShips = [...active.recentShips, summary].slice(-RECENT_SHIPS);
  atomicWrite(recentShipsFile(companyId), JSON.stringify(active.recentShips, null, 2));
};

// ---- the company room ------------------------------------------------------
export const postTeamMessage = (
  companyId: string,
  fromEmployeeId: string | null,
  text: string,
): TeamMessage => {
  const active = requireActiveCompany(companyId);
  const msg: TeamMessage = { companyId, createdAt: Date.now(), fromEmployeeId, text };
  const ring = active.chat;
  const stored: TeamMessage = { ...msg, id: nextId("nextTeamMessageId") };
  ring.push(stored);
  if (ring.length > TEAM_CHAT_RING) {
    ring.splice(0, ring.length - TEAM_CHAT_RING);
  }
  appendJsonl(chatFile(companyId), msg);
  return stored;
};

export const recentTeamMessages = (companyId: string, limit = 20, since = 0): TeamMessage[] => {
  const ring = activeCompany(companyId)?.chat ?? [];
  const filtered = since > 0 ? ring.filter((m) => m.createdAt > since) : ring;
  return filtered.slice(-limit);
};

// ---- tasks -----------------------------------------------------------------
export const createTask = (t: {
  companyId: string;
  productId?: string | null;
  betId?: string | null;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  assigneeId?: string | null;
}): Task => {
  const list = requireActiveCompany(t.companyId).tasks;
  const id = uniqueSlug(
    t.title,
    list.map((x) => x.id),
    (s) =>
      existsSync(path.join(tasksDir(t.companyId), s)) ||
      existsSync(path.join(shippedDir(t.companyId), s)),
  );
  const task: Task = {
    artifacts: [],
    assigneeId: t.assigneeId ?? null,
    attempts: 0,
    betId: t.betId ?? null,
    companyId: t.companyId,
    completedAt: null,
    createdAt: Date.now(),
    description: t.description ?? null,
    id,
    priority: t.priority ?? "medium",
    productId: t.productId ?? null,
    startedAt: null,
    state: { kind: "todo" },
    title: t.title,
  };
  saveTask(task);
  list.push(task);
  return task;
};

/** An open task by id. Shipped work is history, not something to act on. */
export const getTask = (id: string): Task | null =>
  c().active?.tasks.find((task) => task.id === id) ?? null;

const newestFirst = (a: Task, b: Task): number => b.createdAt - a.createdAt;

/** The company's open queue: everything not yet done, newest first. */
export const listOpenTasks = (companyId: string): Task[] =>
  (activeCompany(companyId)?.tasks ?? []).toSorted(newestFirst);

/** Everything the company has finished, newest first. Read from disk the first time it is asked for. */
export const listShippedTasks = (companyId: string): Task[] => {
  const active = activeCompany(companyId);
  if (!active) {
    return [];
  }
  if (active.shipped === null) {
    active.shipped = loadPackages(
      "task",
      shippedDir(companyId),
      (slug) => shippedTaskFile(companyId, slug),
      (doc) => docToTask(doc, companyId),
    );
  }
  return active.shipped.toSorted(newestFirst);
};

export const openTasksFor = (employeeId: string): Task[] =>
  c().active?.tasks.filter((task) => task.assigneeId === employeeId) ?? [];

const TASK_PRIORITY_ORDER = { high: 0, low: 2, medium: 1 } satisfies Record<TaskPriority, number>;

/** Queued tasks eligible to start now (a backoff retry waits for nextAttemptAt). */
export const listQueuedTasks = (): Task[] => {
  const now = Date.now();
  const out = (c().active?.tasks ?? []).filter((task) => {
    const { state } = task;
    return state.kind === "queued" && (state.nextAttemptAt === null || state.nextAttemptAt <= now);
  });
  return out.toSorted(
    (a, b) =>
      TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority] ||
      a.createdAt - b.createdAt,
  );
};

const patchTask = (id: string, patch: Partial<Task>): Task | null =>
  patchIn(c().active?.tasks ?? [], id, patch, saveTask);

type Settled = Extract<TaskState, { kind: "done" | "blocked" }>;

// Persist before shelving so boot can recover a crash between the two writes.
const close = (taskId: string, state: Settled): void => {
  const t = patchTask(taskId, { completedAt: Date.now(), state });
  if (!t || t.state.kind !== "done") {
    return;
  }
  try {
    shelve(t);
  } catch (error) {
    console.error(`could not shelve ${t.id}: ${errorMessage(error)}`);
    return;
  }
  const active = requireActiveCompany(t.companyId);
  const idx = active.tasks.findIndex((task) => task.id === t.id);
  if (idx !== -1) {
    active.tasks.splice(idx, 1);
  }
  active.shipped?.push(t);
};

const heldBy = (t: Task | null, runId: string): Task | null =>
  t && t.state.kind === "running" && t.state.runId === runId ? t : null;

/** Return null on claim conflict; reviving a dead task resets its retry count. */
export const claimTask = (taskId: string, employeeId: string): Task | null => {
  const t = getTask(taskId);
  if (!t) {
    return null;
  }
  const { kind } = t.state;
  const claimable = kind === "todo" || kind === "blocked" || kind === "dead";
  if (!claimable || (t.assigneeId !== null && t.assigneeId !== employeeId)) {
    return null;
  }
  const patch: Partial<Task> = {
    assigneeId: employeeId,
    state: { kind: "queued", lastError: null, nextAttemptAt: null },
  };
  if (kind === "dead") {
    patch.attempts = 0;
  }
  return patchTask(taskId, patch);
};

/** Acquire execution lock: queued -> running, stamp runId. Null if lost race or backing off. */
export const lockTaskForRun = (taskId: string, runId: string): Task | null => {
  const t = getTask(taskId);
  if (!t || t.state.kind !== "queued") {
    return null;
  }
  if (t.state.nextAttemptAt !== null && t.state.nextAttemptAt > Date.now()) {
    return null;
  }
  return patchTask(taskId, { startedAt: Date.now(), state: { kind: "running", runId } });
};

/** The run settled: the task is done, or waits on the founder. Only the owning run may. */
export const settleTask = (taskId: string, runId: string, state: Settled): void => {
  if (!heldBy(getTask(taskId), runId)) {
    return;
  }
  close(taskId, state);
};

const failed = (t: Task, lastError: string) => {
  const now = Date.now();
  const verdict = afterFailure(t.attempts, now);
  const task: Task =
    verdict.kind === "dead"
      ? { ...t, attempts: verdict.attempts, completedAt: now, state: { kind: "dead", lastError } }
      : {
          ...t,
          attempts: verdict.attempts,
          state: { kind: "queued", lastError, nextAttemptAt: verdict.retryAt },
        };
  return { task, verdict };
};

/** A run failed: the task takes its next verdict. Only the owning run may; null when it no longer holds the lock. */
export const failTask = (taskId: string, runId: string, error: string): FailureVerdict | null => {
  const t = heldBy(getTask(taskId), runId);
  if (!t) {
    return null;
  }
  const next = failed(t, error);
  patchTask(taskId, next.task);
  return next.verdict;
};

/** A run parked on a usage limit: back on the queue until it lifts, no attempt burned. Only the owning run may. */
export const parkTask = (taskId: string, runId: string, until: number, lastError: string): void => {
  if (!heldBy(getTask(taskId), runId)) {
    return;
  }
  patchTask(taskId, { state: { kind: "queued", lastError, nextAttemptAt: until } });
};

/** Close the blocked task and create a continuation on the same employee and session. */
export const resolveBlockedWithAnswer = (taskId: string, answer: string): Task | null => {
  const t = getTask(taskId);
  if (!t || t.state.kind !== "blocked" || !t.assigneeId) {
    return null;
  }
  const { ask } = t.state;
  close(taskId, { kind: "done", summary: answeredSummary(answer) });
  return createTask({
    betId: t.betId,
    companyId: t.companyId,
    productId: t.productId,
    ...continuationBrief(t, ask, answer),
    assigneeId: t.assigneeId,
    priority: "high",
  });
};

/** The product an employee is on: their latest task's, else the company's first. */
export const productOfEmployee = (employeeId: string): Product | null => {
  const emp = getEmployee(employeeId);
  if (!emp) {
    return null;
  }
  const [latest] = openTasksFor(employeeId).toSorted(newestFirst);
  const fromTask = latest?.productId ? getProduct(latest.productId) : null;
  return fromTask ?? c().active?.products[0] ?? null;
};

/**
 * Retire a product: its live bets die with it, its open work is dead-lettered,
 * and its package moves to retired/ whole. The last product cannot go — a
 * company with none would be handed a fresh first product at the next boot.
 */
export const killProduct = (productId: string, reason: string): Product | { refused: string } => {
  const product = getProduct(productId);
  if (!product) {
    return { refused: `No product "${productId}".` };
  }
  const active = requireActiveCompany(product.companyId);
  if (active.products.length === 1) {
    return {
      refused: `${product.name} is the only product — start its successor with create_product first.`,
    };
  }
  const now = Date.now();
  for (const bet of active.bets.filter((b) => b.productId === productId && !isClosed(b))) {
    killBet(bet.id, `product retired: ${reason}`, now);
  }
  for (const t of active.tasks.filter((x) => x.productId === productId)) {
    if (t.state.kind !== "running" && t.state.kind !== "done") {
      patchTask(t.id, { completedAt: now, state: { kind: "dead", lastError: "product retired" } });
    }
  }
  active.products.splice(active.products.indexOf(product), 1);
  try {
    moveDir(
      path.join(productsDir(product.companyId), productId),
      path.join(retiredDir(product.companyId), productId),
    );
  } catch {
    /* archive is best-effort — leaving the portfolio is what matters */
  }
  for (const e of active.employees) {
    saveEmployee(e);
  }
  return product;
};

// ---- founding and boot -------------------------------------------------------
/** Publish a complete company with one directory rename; boot ignores staging directories. */
export const foundCompany = (input: {
  name: string;
  mission: string;
  businessType: BusinessTypeId;
  founderName: string;
  founderSpriteSeed: string;
  budget: Budget;
  hires: readonly FoundingHire[];
}): Company => {
  if (c().active) {
    throw new Error("a company is already active");
  }
  if (
    safeReaddir(ROOT_DIR).some((entry) => !entry.startsWith(".") && existsSync(companyFile(entry)))
  ) {
    throw new Error("an existing company save must be loaded or repaired before founding");
  }
  const id = uniqueSlug(input.name, [], (s) => existsSync(companyDir(s)));
  const co: Company = {
    autopilot: true,
    budget: input.budget,
    businessType: input.businessType,
    createdAt: Date.now(),
    founderName: input.founderName,
    founderSpriteSeed: input.founderSpriteSeed,
    id,
    leaderId: null,
    maxAgents: DEFAULT_MAX_AGENTS,
    mission: input.mission,
    name: input.name,
    revenueUsd: null,
    ships: 0,
    spentUsd: 0,
    users: null,
    workspaceDir: companyWorkspace(id),
  };
  const active = emptyCompany(co);
  active.shipped = [];
  if (input.hires.length > co.maxAgents) {
    throw new Error(`the office is at its ${co.maxAgents}-seat cap`);
  }
  active.products.push(firstProduct(co, null));
  for (const [deskIndex, hire] of input.hires.entries()) {
    const employeeId = uniqueSlug(
      hire.name,
      active.employees.map((employee) => employee.id),
    );
    active.employees.push(employeeRecord({ companyId: id, deskIndex, ...hire }, employeeId));
  }
  co.leaderId = leadOf(active.employees);
  for (const routine of defaultRoutines(input.businessType)) {
    const routineId = uniqueSlug(
      routine.name,
      active.routines.map((existing) => existing.id),
    );
    active.routines.push(routineRecord({ companyId: id, ...routine }, routineId));
  }

  const destination = companyDir(id);
  const staging = mkdtempSync(path.join(ROOT_DIR, ".founding-"));
  // Only disk destinations change; persisted workspace paths refer to the final company.
  const staged = (file: string): string => path.join(staging, path.relative(destination, file));
  try {
    mkdirSync(staged(companyWorkspace(id)), { recursive: true });
    mkdirSync(staged(tasksDir(id)), { recursive: true });
    mkdirSync(staged(agentsDir(id)), { recursive: true });
    for (const product of active.products) {
      atomicWrite(staged(productFile(id, product.id)), serializeDoc(productToDoc(product)));
    }
    for (const employee of active.employees) {
      mkdirSync(staged(employeeMemoryDir(id, employee.id)), { recursive: true });
      mkdirSync(staged(employeeSessionDir(id, employee.id)), { recursive: true });
      atomicWrite(
        staged(employeeFile(id, employee.id)),
        serializeDoc(employeeToDoc(employee, co, active.products)),
      );
    }
    for (const routine of active.routines) {
      atomicWrite(staged(routineFile(id, routine.id)), serializeDoc(routineToDoc(routine)));
    }
    atomicWrite(staged(companyFile(id)), serializeDoc(companyToDoc(co)));
    moveDir(staging, destination);
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
  c().active = active;
  return co;
};

const readCompanies = (): Company[] => {
  const companies: Company[] = [];
  for (const entry of safeReaddir(ROOT_DIR)) {
    if (entry.startsWith(".")) {
      continue;
    }
    const file = companyFile(entry);
    if (!existsSync(file)) {
      continue;
    }
    try {
      const company = docToCompany(parseDoc(readFileSync(file, "utf-8")));
      if (company.id !== entry) {
        throw new Error("company slug does not match its directory");
      }
      companies.push(company);
    } catch (error) {
      skip("company", file, error);
    }
  }
  return companies;
};

/** Recover the active company's interrupted runs and shelve its unshelved work. */
const settleLoadedTasks = (company: Company, tasks: Task[]): Task[] => {
  for (const [i, task] of tasks.entries()) {
    if (task.state.kind !== "running") {
      continue;
    }
    const recovered: Task = task.assigneeId
      ? failed(task, "Interrupted by app restart").task
      : { ...task, state: { kind: "todo" } };
    tasks[i] = recovered;
    saveTask(recovered);
  }
  for (const task of tasks) {
    if (task.state.kind !== "done") {
      continue;
    }
    try {
      shelve(task);
    } catch (error) {
      skip("task", taskFile(company.id, task.id), error);
    }
  }
  return tasks.filter((task) => task.state.kind !== "done");
};

const loadActiveCompany = (company: Company): ActiveCompany => {
  const active = emptyCompany(company);
  active.employees = loadPackages(
    "employee",
    agentsDir(company.id),
    (slug) => employeeFile(company.id, slug),
    (doc) => docToEmployee(doc, company.id),
  )
    .map(withRunState)
    .toSorted(byAge);
  const tasks = loadPackages(
    "task",
    tasksDir(company.id),
    (slug) => taskFile(company.id, slug),
    (doc) => docToTask(doc, company.id),
  ).toSorted(byAge);
  active.tasks = settleLoadedTasks(company, tasks);
  active.products = loadPackages(
    "product",
    productsDir(company.id),
    (slug) => productFile(company.id, slug),
    (doc) => docToProduct(doc, company.id),
  ).toSorted(byAge);
  active.bets = loadPackages(
    "bet",
    betsDir(company.id),
    (slug) => betFile(company.id, slug),
    (doc) => docToBet(doc, company.id),
  ).toSorted(byAge);
  active.policy = readJsonFile(policyFile(company.id), PolicyParamsSchema) ?? DEFAULT_POLICY;
  active.routines = loadPackages(
    "routine",
    routinesDir(company.id),
    (slug) => routineFile(company.id, slug),
    (doc) => docToRoutine(doc, company.id),
  );
  adoptLegacyTeam(company);
  loadRecentChat(active);
  active.sinceLastLook = readJsonFile(sinceLastLookFile(company.id), DigestSchema);
  active.recentShips = readJsonFile(recentShipsFile(company.id), RecentShipsSchema) ?? [];
  return active;
};

/** Migrate legacy company-level product metrics before rendering instructions. */
const ensureFirstProduct = (active: ActiveCompany): void => {
  if (active.products.length > 0) {
    return;
  }
  const { company } = active;
  const legacy = readMetricsConfig(company.id)?.vercel;
  const first = firstProduct(
    company,
    legacy
      ? {
          projectId: legacy.projectId,
          projectName: legacy.projectName ?? legacy.projectId,
          teamId: legacy.teamId ?? null,
        }
      : null,
  );
  active.products.push(first);
  saveProduct(first);
  if (legacy) {
    writeMetricsConfig(company.id, { vercel: undefined });
  }
};

export const initStore = (): LoadReport => {
  ensureAppDirs();
  lastLoad = { companies: 0, skipped: [] };
  cache = { active: null, nextActivityId: 1, nextTeamMessageId: 1 };
  const companies = readCompanies();
  // Company errors block the office UI; no hidden company may run behind it.
  if (lastLoad.skipped.some((issue) => issue.kind === "company")) {
    return lastLoad;
  }
  // Newest save wins; equal timestamps use the first slug alphabetically.
  const [company] = companies.toSorted(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
  if (!company) {
    return lastLoad;
  }
  try {
    const active = loadActiveCompany(company);
    cache.active = active;
    ensureFirstProduct(active);
    if (active.employees.length > 0 && !active.employees.some((e) => e.id === company.leaderId)) {
      active.company = { ...company, leaderId: leadOf(active.employees) };
      saveCompany(active.company);
    }
    dropRetiredRoutines(active);
    if (active.routines.length === 0) {
      seedDefaultRoutines(company.id, company.businessType);
    }
    for (const employee of active.employees) {
      try {
        saveEmployee(employee, { onlyIfChanged: true });
      } catch (error) {
        skip("employee", employeeFile(company.id, employee.id), error);
      }
    }
    lastLoad.companies = 1;
  } catch (error) {
    cache.active = null;
    skip("company", companyFile(company.id), error);
  }
  return lastLoad;
};

// ---- activity log ----------------------------------------------------------
const saveSinceLastLook = (active: ActiveCompany, next: Digest): void => {
  active.sinceLastLook = next;
  atomicWrite(sinceLastLookFile(active.company.id), JSON.stringify(next, null, 2));
};

/** The founder has the office in view as of `at`: what came before is seen, and the count starts over. */
export const markSeen = (companyId: string, at: number): void => {
  const active = activeCompany(companyId);
  if (active) {
    saveSinceLastLook(active, emptyDigest(at));
  }
};

export const logActivity = (row: PersistedActivity, persist: boolean): ActivityEvent => {
  const entry: ActivityEvent = { ...row, id: nextId("nextActivityId") };
  const { active } = c();
  if (!persist || !active) {
    return entry;
  }
  appendJsonl(activityFile(active.company.id), row);
  const folded = active.sinceLastLook && foldDigest(active.sinceLastLook, row);
  if (folded) {
    saveSinceLastLook(active, folded);
  }
  return entry;
};

/** The digest, and the look itself: reading it starts the next one. Null before a first look. */
export const digest = (companyId: string): Digest | null => {
  const current = activeCompany(companyId)?.sinceLastLook ?? null;
  markSeen(companyId, Date.now());
  return current;
};
