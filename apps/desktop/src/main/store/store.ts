import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, atomicWrite, moveDir, readJsonFile, readJsonlTail } from "@/main/lib/fs";
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
  shippedDir,
  shippedTaskFile,
  productsDir,
  productFile,
  productWorkspace,
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
import { defaultRoutines, type RoutineDefinition } from "@/main/prompts/routines";
import { docToProduct, productToDoc } from "@/main/store/product-codec";
import { docToTask, taskToDoc } from "@/main/store/task-codec";
import { readMetricsConfig, writeMetricsConfig } from "@/main/metrics";
import { errorMessage } from "@/shared/errors";
import type { LoadReport, LoadSkip } from "@/shared/ipc-registry";
import { isRunnerId } from "@repo/agent-driver/runner";
import {
  BUSINESS_TYPES,
  DEFAULT_FOUNDER_SEED,
  DEFAULT_MAX_AGENTS,
  afterFailure,
} from "@/shared/domain";
import {
  PersistedActivitySchema,
  type ActivityEvent,
  type ActivityKind,
  type PersistedActivity,
} from "@/shared/activity";
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
  shipped: Task[] | null; // Loaded only when the shipping log is opened.
  products: Product[];
  routines: Routine[];
  chat: TeamMessage[];
  activity: ActivityEvent[];
}

interface Cache {
  active: ActiveCompany | null;
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

function activeCompany(companyId: string): ActiveCompany | null {
  const active = c().active;
  return active?.company.id === companyId ? active : null;
}

function requireActiveCompany(companyId: string): ActiveCompany {
  const active = activeCompany(companyId);
  if (!active) throw new Error(`company ${companyId} is not active`);
  return active;
}

function emptyCompany(company: Company): ActiveCompany {
  return {
    company,
    employees: [],
    tasks: [],
    shipped: null,
    products: [],
    routines: [],
    chat: [],
    activity: [],
  };
}

interface Owned {
  id: string;
  companyId: string;
}

function patchIn<T extends Owned>(
  list: T[],
  id: string,
  patch: Partial<T>,
  save: (row: T) => void,
): T | null {
  const idx = list.findIndex((row) => row.id === id);
  const cur = list[idx];
  if (!cur) return null;
  const next = { ...cur, ...patch, id: cur.id, companyId: cur.companyId };
  list[idx] = next;
  save(next);
  return next;
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

function employeeBody(e: Employee, co: Company): string {
  return standingInstructions({
    employee: e,
    company: co,
    products: requireActiveCompany(co.id).products,
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
function saveEmployee(e: Employee, opts: { onlyIfChanged?: boolean } = {}): void {
  const co = requireCompany(e.companyId);
  const file = employeeFile(e.companyId, e.id);
  const text = serializeDoc(employeeToDoc(e, co));
  if (opts.onlyIfChanged && readTextIfPresent(file) === text) return;
  atomicWrite(file, text);
}

function readTextIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function saveTask(t: Task): void {
  atomicWrite(taskFile(t.companyId, t.id), serializeDoc(taskToDoc(t)));
}
function saveProduct(p: Product): void {
  atomicWrite(productFile(p.companyId, p.id), serializeDoc(productToDoc(p)));
}
function shelve(t: Task): void {
  moveDir(join(tasksDir(t.companyId), t.id), join(shippedDir(t.companyId), t.id));
}

const ACTIVITY_RING = 600;

// ---- boot -------------------------------------------------------------------
/** Oldest first; ties (same millisecond) by id, so boot order is stable. */
const byAge = <T extends { createdAt: number; id: string }>(a: T, b: T): number =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

// Failed company loads must surface in the UI instead of presenting onboarding over a save.
let lastLoad: LoadReport = { companies: 0, skipped: [] };
export const loadReport = (): LoadReport => lastLoad;

function skip(kind: LoadSkip["kind"], path: string, cause: unknown): void {
  lastLoad.skipped.push({ kind, path, error: errorMessage(cause) });
}

/** Report corrupt packages individually so one hand-edited file cannot prevent loading. */
function loadPackages<T extends { id: string }>(
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
      const row = decode(parseDoc(readFileSync(file, "utf8")));
      if (row.id !== slug) throw new Error("package slug does not match its directory");
      rows.push(row);
    } catch (cause) {
      skip(kind, file, cause);
    }
  }
  return rows;
}

export function initStore(): LoadReport {
  ensureAppDirs();
  lastLoad = { companies: 0, skipped: [] };
  cache = { active: null, nextActivityId: 1, nextTeamMessageId: 1 };
  const companies: Company[] = [];

  for (const entry of safeReaddir(ROOT_DIR)) {
    if (entry.startsWith(".")) continue;
    const file = companyFile(entry);
    if (!existsSync(file)) continue;
    try {
      const company = docToCompany(parseDoc(readFileSync(file, "utf8")));
      if (company.id !== entry) throw new Error("company slug does not match its directory");
      companies.push(company);
    } catch (cause) {
      skip("company", file, cause);
    }
  }

  // Company errors block the office UI; no hidden company may run behind it.
  if (lastLoad.skipped.some((issue) => issue.kind === "company")) return lastLoad;
  // Newest save wins; equal timestamps use the first slug alphabetically.
  const company = companies.toSorted(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  )[0];
  if (!company) return lastLoad;
  const active = emptyCompany(company);

  try {
    active.employees = loadPackages(
      "employee",
      agentsDir(company.id),
      (slug) => employeeFile(company.id, slug),
      (doc) => docToEmployee(doc, company.id),
    ).toSorted(byAge);
    const tasks = loadPackages(
      "task",
      tasksDir(company.id),
      (slug) => taskFile(company.id, slug),
      (doc) => docToTask(doc, company.id),
    ).toSorted(byAge);
    // Recover only the active company's interrupted runs and unshelved work.
    for (const [i, task] of tasks.entries()) {
      if (task.state.kind !== "running") continue;
      const recovered: Task = task.assigneeId
        ? failed(task, "Interrupted by app restart").task
        : { ...task, state: { kind: "todo" } };
      tasks[i] = recovered;
      saveTask(recovered);
    }
    for (const task of tasks) {
      if (task.state.kind !== "done") continue;
      try {
        shelve(task);
      } catch (cause) {
        skip("task", taskFile(company.id, task.id), cause);
      }
    }
    active.tasks = tasks.filter((task) => task.state.kind !== "done");
    active.products = loadPackages(
      "product",
      productsDir(company.id),
      (slug) => productFile(company.id, slug),
      (doc) => docToProduct(doc, company.id),
    ).toSorted(byAge);
    active.routines = loadPackages(
      "routine",
      routinesDir(company.id),
      (slug) => routineFile(company.id, slug),
      (doc) => docToRoutine(doc, company.id),
    );
    adoptLegacyTeam(company);
    loadRecentChat(active);
    loadRecentActivity(active);
    cache.active = active;

    // Migrate legacy company-level product metrics before rendering instructions.
    if (active.products.length === 0) {
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
      if (legacy) writeMetricsConfig(company.id, { vercel: undefined });
    }
    if (active.employees.length > 0 && !active.employees.some((e) => e.id === company.leaderId)) {
      active.company = { ...company, leaderId: leadOf(active.employees) };
      saveCompany(active.company);
    }
    if (active.routines.length === 0) seedDefaultRoutines(company.id, company.businessType);
    for (const employee of active.employees) {
      try {
        saveEmployee(employee, { onlyIfChanged: true });
      } catch (cause) {
        skip("employee", employeeFile(company.id, employee.id), cause);
      }
    }
    lastLoad.companies = 1;
  } catch (cause) {
    cache.active = null;
    skip("company", companyFile(company.id), cause);
  }
  return lastLoad;
}

/** Adopt legacy team leadership and chat without deleting the original files. */
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

function leadOf(emps: readonly Employee[]): string | null {
  const byRole = emps.find((e) => LEADER_RX.test(`${e.role} ${e.title}`));
  return (byRole ?? emps[0])?.id ?? null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function loadRecentActivity(active: ActiveCompany): void {
  const rows = readJsonlTail(
    activityFile(active.company.id),
    PersistedActivitySchema,
    ACTIVITY_RING,
  );
  for (const row of rows) active.activity.push({ ...row, id: c().nextActivityId++ });
}

const TEAM_CHAT_RING = 200;

// One chat.jsonl line, as postTeamMessage persists it (id and companyId re-assigned on load).
const PersistedTeamMessageSchema = z.object({
  fromEmployeeId: z.string().nullable(),
  text: z.string(),
  createdAt: z.number(),
});

function loadRecentChat(active: ActiveCompany): void {
  const companyId = active.company.id;
  const rows = readJsonlTail(chatFile(companyId), PersistedTeamMessageSchema, TEAM_CHAT_RING);
  for (const row of rows) active.chat.push({ ...row, id: c().nextTeamMessageId++, companyId });
}

// ---- slug allocation ---------------------------------------------------------
/** Scan suffixes once; onDisk also protects packages skipped during loading. */
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

/** Write COMPANY.md last: boot ignores incomplete founding directories. */
export function foundCompany(input: {
  name: string;
  mission: string;
  businessType: BusinessTypeId;
  founderName: string;
  founderSpriteSeed: string;
  budget: Budget;
  hires: readonly FoundingHire[];
}): Company {
  if (c().active) throw new Error("a company is already active");
  if (safeReaddir(ROOT_DIR).some((entry) => existsSync(companyFile(entry)))) {
    throw new Error("an existing company save must be loaded or repaired before founding");
  }
  const id = uniqueSlug(input.name, [], (s) => existsSync(companyDir(s)));
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
  const active = emptyCompany(co);
  active.shipped = [];
  c().active = active;
  try {
    mkdirSync(companyWorkspace(id), { recursive: true });
    mkdirSync(tasksDir(id), { recursive: true });
    mkdirSync(agentsDir(id), { recursive: true });
    const first = firstProduct(co, null);
    active.products.push(first);
    saveProduct(first);
    input.hires.forEach((hire, deskIndex) => createEmployee({ companyId: id, deskIndex, ...hire }));
    co.leaderId = leadOf(listEmployees(id));
    seedDefaultRoutines(id, input.businessType);
    saveCompany(co);
  } catch (cause) {
    c().active = null;
    rmSync(companyDir(id), { recursive: true, force: true });
    throw cause;
  }
  return co;
}

function seedDefaultRoutines(companyId: string, businessType: BusinessTypeId): void {
  for (const routine of defaultRoutines(businessType)) {
    createRoutine({ companyId, ...routine });
  }
}

function createRoutine(input: RoutineDefinition & { companyId: string }): Routine {
  const list = requireActiveCompany(input.companyId).routines;
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
  return [...(activeCompany(companyId)?.routines ?? [])];
}

export function markRoutineRun(companyId: string, routineId: string): void {
  const list = activeCompany(companyId)?.routines;
  const r = list?.find((x) => x.id === routineId);
  if (!r) return;
  r.lastRunAt = Date.now();
  saveRoutine(r);
}

// ---- teams -----------------------------------------------------------------
/** Archive the employee package and unassign queued work. */
export function archiveEmployee(employeeId: string): Employee | null {
  const emp = getEmployee(employeeId);
  if (!emp) return null;
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
  if (idx >= 0) active.employees.splice(idx, 1);
  try {
    moveDir(
      employeeAgentDir(emp.companyId, employeeId),
      join(alumniDir(emp.companyId), employeeId),
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
}

// ---- the company room ------------------------------------------------------
export function postTeamMessage(
  companyId: string,
  fromEmployeeId: string | null,
  text: string,
): TeamMessage {
  const active = requireActiveCompany(companyId);
  const msg: TeamMessage = { companyId, fromEmployeeId, text, createdAt: Date.now() };
  const ring = active.chat;
  const stored: TeamMessage = { ...msg, id: c().nextTeamMessageId++ };
  ring.push(stored);
  if (ring.length > TEAM_CHAT_RING) ring.splice(0, ring.length - TEAM_CHAT_RING);
  appendJsonl(chatFile(companyId), msg);
  return stored;
}

export function recentTeamMessages(companyId: string, limit = 20, since = 0): TeamMessage[] {
  const ring = activeCompany(companyId)?.chat ?? [];
  const filtered = since > 0 ? ring.filter((m) => m.createdAt > since) : ring;
  return filtered.slice(-limit);
}

export function getCompany(id: string): Company | null {
  return activeCompany(id)?.company ?? null;
}

export function requireCompany(id: string): Company {
  const company = getCompany(id);
  if (!company) throw new Error(`company ${id} not found`);
  return company;
}

export function getDefaultCompany(): Company | null {
  return c().active?.company ?? null;
}

function patchCompany(id: string, patch: Partial<Company>): Company {
  const active = requireActiveCompany(id);
  const co = active.company;
  const next = { ...co, ...patch, id: co.id };
  active.company = next;
  saveCompany(next);
  return next;
}

export function setMaxAgents(id: string, maxAgents: number): Company {
  return patchCompany(id, { maxAgents: Math.max(1, Math.round(maxAgents)) });
}
export function setAutopilot(id: string, on: boolean): Company {
  return patchCompany(id, { autopilot: on });
}
export function recordShip(companyId: string, productId: string | null): void {
  const co = getCompany(companyId);
  if (!co) return;
  patchCompany(companyId, { ships: co.ships + 1 });
  const product = productId === null ? null : getProduct(productId);
  if (product) patchProduct(product.id, { ships: product.ships + 1, lastShipAt: Date.now() });
}

// ---- products --------------------------------------------------------------
/** The first product shares the company workspace and inherits its legacy metrics. */
function firstProduct(co: Company, vercel: VercelBinding | null): Product {
  return {
    id: uniqueSlug(co.name, [], (s) => existsSync(join(productsDir(co.id), s))),
    companyId: co.id,
    name: co.name,
    description: co.mission,
    workspaceDir: co.workspaceDir,
    ships: co.ships,
    lastShipAt: null,
    users: co.users,
    vercel,
    createdAt: co.createdAt,
  };
}

export const getProduct = (id: string): Product | null =>
  c().active?.products.find((product) => product.id === id) ?? null;
export function requireProduct(id: string): Product {
  const p = getProduct(id);
  if (!p) throw new Error(`no product ${id}`);
  return p;
}
export function listProducts(companyId: string): Product[] {
  return [...(activeCompany(companyId)?.products ?? [])];
}

const patchProduct = (id: string, patch: Partial<Product>): Product | null =>
  patchIn(c().active?.products ?? [], id, patch, saveProduct);

export function createProduct(input: {
  companyId: string;
  name: string;
  description: string;
}): Product {
  const list = requireActiveCompany(input.companyId).products;
  const id = uniqueSlug(
    input.name,
    list.map((p) => p.id),
    (s) => existsSync(join(productsDir(input.companyId), s)),
  );
  const product: Product = {
    id,
    companyId: input.companyId,
    name: input.name.trim(),
    description: input.description.trim(),
    workspaceDir: productWorkspace(input.companyId, id),
    ships: 0,
    lastShipAt: null,
    users: null,
    vercel: null,
    createdAt: Date.now(),
  };
  mkdirSync(product.workspaceDir, { recursive: true });
  saveProduct(product);
  list.push(product);
  for (const e of listEmployees(input.companyId)) saveEmployee(e);
  return product;
}

export function setProductVercel(productId: string, vercel: VercelBinding | null): Product | null {
  return patchProduct(productId, { vercel });
}

/** Real visitors per product, from the pulse; a null keeps the last-known value. */
export function setProductUsers(productId: string, users: number | null): void {
  if (users !== null) patchProduct(productId, { users: Math.max(0, Math.round(users)) });
}

/** Where autopilot turns next: the product that has waited longest for a ship. */
export function attentionProduct(companyId: string): Product | null {
  const products = activeCompany(companyId)?.products ?? [];
  return products.toSorted((a, b) => (a.lastShipAt ?? 0) - (b.lastShipAt ?? 0))[0] ?? null;
}

/** The product an employee is on: their latest task's, else the company's first. */
export function productOfEmployee(employeeId: string): Product | null {
  const emp = getEmployee(employeeId);
  if (!emp) return null;
  const latest = openTasksFor(employeeId).toSorted(newestFirst)[0];
  const fromTask = latest?.productId ? getProduct(latest.productId) : null;
  return fromTask ?? c().active?.products[0] ?? null;
}
// ---- founder approvals -------------------------------------------------------
// Exact-command approvals survive restart and are consumed once.
function readApprovals(companyId: string): string[] {
  requireActiveCompany(companyId);
  return readJsonFile(approvalsFile(companyId), z.array(z.string())) ?? [];
}

export function grantApproval(companyId: string, key: string): void {
  const keys = readApprovals(companyId);
  if (keys.includes(key)) return;
  atomicWrite(approvalsFile(companyId), JSON.stringify([...keys, key], null, 2));
}

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

export function recordSpend(id: string, costUsd: number): Company | null {
  const co = getCompany(id);
  if (!co) return null;
  const spent = Math.round((co.spentUsd + Math.max(0, costUsd)) * 10_000) / 10_000;
  return patchCompany(id, { spentUsd: spent });
}
export function setBudget(id: string, budget: Budget): Company {
  return patchCompany(id, { budget });
}
export function resetSpend(id: string): Company {
  return patchCompany(id, { spentUsd: 0 });
}
/** Null metrics keep the last reported value through provider failures. */
export function setRealMetrics(
  id: string,
  snapshot: { users: number | null; revenue: number | null },
): Company | null {
  const co = getCompany(id);
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
  const { company, employees: list } = requireActiveCompany(input.companyId);
  if (list.length >= company.maxAgents) {
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

export const getEmployee = (id: string): Employee | null =>
  c().active?.employees.find((employee) => employee.id === id) ?? null;

export function employeeInstructions(employeeId: string): string {
  const e = getEmployee(employeeId);
  if (!e) throw new Error(`employee ${employeeId} not found`);
  const co = requireCompany(e.companyId);
  return employeeBody(e, co);
}

export function listEmployees(companyId: string): Employee[] {
  return [...(activeCompany(companyId)?.employees ?? [])];
}

/** A run started or settled. Memory only: a fresh boot has no live runs, so disk would only lie. */
export function setEmployeeStatus(id: string, status: Employee["status"]): void {
  const emp = getEmployee(id);
  if (emp) emp.status = status;
}
export function setEmployeeSession(id: string, sessionId: string | null): void {
  patchIn(c().active?.employees ?? [], id, { sessionId }, saveEmployee);
}

// ---- tasks -----------------------------------------------------------------
export function createTask(t: {
  companyId: string;
  productId?: string | null;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  assigneeId?: string | null;
}): Task {
  const list = requireActiveCompany(t.companyId).tasks;
  const id = uniqueSlug(
    t.title,
    list.map((x) => x.id),
    (s) =>
      existsSync(join(tasksDir(t.companyId), s)) || existsSync(join(shippedDir(t.companyId), s)),
  );
  const task: Task = {
    id,
    companyId: t.companyId,
    productId: t.productId ?? null,
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

/** An open task by id. Shipped work is history, not something to act on. */
export const getTask = (id: string): Task | null =>
  c().active?.tasks.find((task) => task.id === id) ?? null;

const newestFirst = (a: Task, b: Task): number => b.createdAt - a.createdAt;

/** The company's open queue: everything not yet done, newest first. */
export function listOpenTasks(companyId: string): Task[] {
  return (activeCompany(companyId)?.tasks ?? []).toSorted(newestFirst);
}

/** Everything the company has finished, newest first. Read from disk the first time it is asked for. */
export function listShippedTasks(companyId: string): Task[] {
  const active = activeCompany(companyId);
  if (!active) return [];
  if (active.shipped === null) {
    active.shipped = loadPackages(
      "task",
      shippedDir(companyId),
      (slug) => shippedTaskFile(companyId, slug),
      (doc) => docToTask(doc, companyId),
    );
  }
  return active.shipped.toSorted(newestFirst);
}

export function openTasksFor(employeeId: string): Task[] {
  return c().active?.tasks.filter((task) => task.assigneeId === employeeId) ?? [];
}

const TASK_PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } satisfies Record<TaskPriority, number>;

/** Queued tasks eligible to start now (a backoff retry waits for nextAttemptAt). */
export function listQueuedTasks(): Task[] {
  const now = Date.now();
  const out = (c().active?.tasks ?? []).filter((task) => {
    const state = task.state;
    return state.kind === "queued" && (state.nextAttemptAt === null || state.nextAttemptAt <= now);
  });
  return out.toSorted(
    (a, b) =>
      TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority] ||
      a.createdAt - b.createdAt,
  );
}

const patchTask = (id: string, patch: Partial<Task>): Task | null =>
  patchIn(c().active?.tasks ?? [], id, patch, saveTask);

type Settled = Extract<TaskState, { kind: "done" | "blocked" }>;

// Persist before shelving so boot can recover a crash between the two writes.
function close(taskId: string, state: Settled): void {
  const t = patchTask(taskId, { state, completedAt: Date.now() });
  if (!t || t.state.kind !== "done") return;
  try {
    shelve(t);
  } catch (cause) {
    console.error(`could not shelve ${t.id}: ${errorMessage(cause)}`);
    return;
  }
  const active = requireActiveCompany(t.companyId);
  const idx = active.tasks.findIndex((task) => task.id === t.id);
  if (idx >= 0) active.tasks.splice(idx, 1);
  active.shipped?.push(t);
}

const heldBy = (t: Task | null, runId: string): Task | null =>
  t && t.state.kind === "running" && t.state.runId === runId ? t : null;

/** Return null on claim conflict; reviving a dead task resets its retry count. */
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
export function settleTask(taskId: string, runId: string, state: Settled): void {
  if (!heldBy(getTask(taskId), runId)) return;
  close(taskId, state);
}

function failed(t: Task, lastError: string) {
  const now = Date.now();
  const verdict = afterFailure(t.attempts, now);
  const task: Task =
    verdict.kind === "dead"
      ? { ...t, attempts: verdict.attempts, state: { kind: "dead", lastError }, completedAt: now }
      : {
          ...t,
          attempts: verdict.attempts,
          state: { kind: "queued", nextAttemptAt: verdict.retryAt, lastError },
        };
  return { task, verdict };
}

/** A run failed: the task takes its next verdict. Only the owning run may; null when it no longer holds the lock. */
export function failTask(taskId: string, runId: string, error: string): FailureVerdict | null {
  const t = heldBy(getTask(taskId), runId);
  if (!t) return null;
  const next = failed(t, error);
  patchTask(taskId, next.task);
  return next.verdict;
}

/** A run parked on a usage limit: back on the queue until it lifts, no attempt burned. Only the owning run may. */
export function parkTask(taskId: string, runId: string, until: number, lastError: string): void {
  if (!heldBy(getTask(taskId), runId)) return;
  patchTask(taskId, { state: { kind: "queued", nextAttemptAt: until, lastError } });
}

/** Close the blocked task and create a continuation on the same employee and session. */
export function resolveBlockedWithAnswer(taskId: string, answer: string): Task | null {
  const t = getTask(taskId);
  if (!t || t.state.kind !== "blocked" || !t.assigneeId) return null;
  const { ask } = t.state;
  close(taskId, { kind: "done", summary: answeredSummary(answer) });
  return createTask({
    companyId: t.companyId,
    productId: t.productId,
    ...continuationBrief(t, ask, answer),
    priority: "high",
    assigneeId: t.assigneeId,
  });
}

// ---- activity log ----------------------------------------------------------
export function logActivity(row: PersistedActivity, persist: boolean): ActivityEvent {
  const entry: ActivityEvent = { ...row, id: c().nextActivityId++ };
  const active = c().active;
  if (!persist || !active) return entry;
  active.activity.push(entry);
  if (active.activity.length > ACTIVITY_RING)
    active.activity = active.activity.slice(-ACTIVITY_RING);
  appendJsonl(activityFile(active.company.id), row);
  return entry;
}

const ofKind =
  <K extends ActivityKind>(kind: K) =>
  (e: ActivityEvent): e is Extract<ActivityEvent, { kind: K }> =>
    e.kind === kind;

export function recentActivity<K extends ActivityKind>(
  companyId: string,
  kind: K,
  limit = 12,
): Extract<ActivityEvent, { kind: K }>[] {
  const active = activeCompany(companyId);
  if (!active) return [];
  const ids = new Set(active.employees.map((e) => e.id));
  const isKind = ofKind(kind);
  const out: Extract<ActivityEvent, { kind: K }>[] = [];
  const ring = active.activity;
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ring[i];
    if (e && isKind(e) && e.employeeId != null && ids.has(e.employeeId)) out.push(e);
  }
  return out.toReversed();
}
