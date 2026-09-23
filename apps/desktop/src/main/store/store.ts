import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { appendJsonl, atomicWrite, moveDir, readJsonFile, readJsonlTail } from "@/main/lib/fs";
import {
  ROOT_DIR,
  ensureAppDirs,
  companyDir,
  companyFile,
  companySharedDir,
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
  PACKAGE_SCHEMA,
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
import { continuationBrief } from "@/main/prompts/briefs";
import { standingInstructions } from "@/main/prompts/instructions";
import { RETIRED_ROUTINES, defaultRoutines } from "@/main/prompts/routines";
import type { RoutineDefinition } from "@/main/prompts/routines";
import { betToDoc, docToBet } from "@/main/store/bet-codec";
import { docToProduct, productToDoc } from "@/main/store/product-codec";
import { docToTask, taskToDoc } from "@/main/store/task-codec";
import { readMetricsConfig, writeMetricsConfig } from "@/main/store/metrics-config";
import {
  DEFAULT_POLICY,
  PolicyParamsSchema,
  claimsCollide,
  defaultLandingPath,
  dream,
  isClosed,
  judge,
  windowEnd,
} from "@/shared/bets";
import type { Bet, PolicyParams } from "@/shared/bets";
import { errorMessage } from "@/shared/errors";
import { emptyDigest, foldDigest } from "@/main/store/digest";
import { DigestSchema } from "@/shared/digest";
import type { Digest } from "@/shared/digest";
import type {
  AgentRunner,
  Budget,
  BusinessTypeId,
  Company,
  Employee,
  FailureVerdict,
  LoadReport,
  LoadSkip,
  OpenTaskStatus,
  Product,
  ProductDraft,
  Routine,
  ShipLine,
  Task,
  TaskOrigin,
  TaskPriority,
  TaskState,
  TaskStatus,
  TeamMessage,
  VercelBinding,
} from "@/shared/domain";
import { isRunnerId } from "@repo/agent-driver/runner";
import {
  BUSINESS_TYPES,
  DEFAULT_FOUNDER_SEED,
  DEFAULT_MAX_AGENTS,
  LastShipSchema,
  RunMetricsSchema,
  afterFailure,
  entering,
  leadOf,
  taskIn,
} from "@/shared/domain";
import type { ActivityEvent, PersistedActivity } from "@/shared/activity";

// Synchronous cache mutations make check-and-set atomic in the main process.
// Markdown writes use tmp+rename; activity and chat use append-only JSONL logs.

const GrantSchema = z.object({ grantedAt: z.number(), key: z.string(), taskId: z.string() });
type Grant = z.infer<typeof GrantSchema>;

interface ActiveCompany {
  company: Company;
  employees: Employee[];
  tasks: Task[];
  // Loaded only when the shipping log is opened.
  shipped: Task[] | null;
  products: Product[];
  /** Sign-offs the founder gave that no run has used yet. */
  grants: Grant[];
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

/** The company this launch runs, or null before one is founded. */
const maybeCurrent = (): ActiveCompany | null => c().active;

/** The company this launch runs. There is only ever one, so nothing takes its id; asking with none loaded is a bug in the caller. */
const current = (): ActiveCompany => {
  const company = c().active;
  if (!company) {
    throw new Error("no company is loaded");
  }
  return company;
};

const emptyCompany = (company: Company): ActiveCompany => ({
  bets: [],
  chat: [],
  company,
  employees: [],
  grants: [],
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

const patchedRow = <T extends Owned>(list: T[], id: string, patch: Partial<T>) => {
  const idx = list.findIndex((row) => row.id === id);
  const cur = list[idx];
  // every caller looked the row up first, so a missing one is a bug, not an outcome
  if (!cur) {
    throw new Error(`nothing to patch at "${id}"`);
  }
  return { idx, next: { ...cur, ...patch, companyId: cur.companyId, id: cur.id } };
};

/** A change that holds only once saved, like a lock: a save that throws leaves the row as the disk has it. */
const patchIn = <T extends Owned>(
  list: T[],
  id: string,
  patch: Partial<T>,
  save: (row: T) => void,
): T => {
  const { idx, next } = patchedRow(list, id, patch);
  save(next);
  list[idx] = next;
  return next;
};

/**
 * A record of what already happened, like a run ending or money spent: the cache takes it even
 * when the save throws. The row's next write carries it to disk, and boot recovers a task the
 * disk still has running.
 */
const recordIn = <T extends Owned>(
  list: T[],
  id: string,
  patch: Partial<T>,
  save: (row: T) => void,
): T => {
  const { idx, next } = patchedRow(list, id, patch);
  try {
    save(next);
  } finally {
    list[idx] = next;
  }
  return next;
};

// ---- serialization ----------------------------------------------------------
/**
 * What this build writes. A save stamped higher was written by a newer build:
 * writers rebuild every file from what they understand, so opening it would
 * quietly drop whatever the newer build added. It is refused instead. A save
 * stamped lower is adopted once at boot, then carries this stamp.
 */
const SAVE_FORMAT = 4;

const formatOf = (doc: FrontmatterDoc): number => optNum(doc.metadata, "format", 0);

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
  metadata.format = SAVE_FORMAT;
  return {
    body: `# ${co.name}\n\n${co.mission}\n`,
    fields: {
      description: co.mission,
      kind: "company",
      name: co.name,
      schema: PACKAGE_SCHEMA,
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
  if (formatOf(doc) > SAVE_FORMAT) {
    throw new Error(
      `this save was written by a newer IdleBiz (format ${formatOf(doc)}, this build reads ${SAVE_FORMAT}) — update the app to open it`,
    );
  }
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
    workspaceDir: companySharedDir(id),
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
      schema: PACKAGE_SCHEMA,
      slug: e.id,
    },
    metadata,
  };
};

/** What a run leaves for the next one; kept out of AGENTS.md so the instructions only change when they do. */
const RunStateSchema = z.object({
  // defaulted like lastShip; a file without it reads as never told, so the next run sends them once
  instructionsDigest: z.string().nullable().default(null),
  lastRunMetrics: RunMetricsSchema.nullable(),
  // defaulted: a file without it must still parse, or its session would be dropped with it
  lastShip: LastShipSchema.nullable().default(null),
  sessionId: z.string().nullable(),
});

const saveRunState = (e: Employee): void => {
  const state: z.infer<typeof RunStateSchema> = {
    instructionsDigest: e.instructionsDigest,
    lastRunMetrics: e.lastRunMetrics,
    lastShip: e.lastShip,
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
    instructionsDigest: null,
    lastRunMetrics: null,
    lastShip: null,
    name: reqStr(f, "name"),
    persona: optStr(m, "persona") ?? "",
    role: optStr(m, "role") ?? "general",
    runner: parseRunner(optStr(m, "runner")),
    // saves from before run-state.json kept the session here; adoptOlderSave moves it into run-state.json
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
    fields: { name: r.name, schema: PACKAGE_SCHEMA, slug: r.id },
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
  const { company, products } = current();
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
const firstFree = (root: string, taken: (slug: string) => boolean): string => {
  let slug = root;
  for (let n = 2; taken(slug); n += 1) {
    slug = `${root}-${n}`;
  }
  return slug;
};

/** onDisk also protects packages skipped during loading. */
const uniqueSlug = (
  base: string,
  existing: Iterable<string>,
  onDisk: (slug: string) => boolean = () => false,
): string => {
  const ids = new Set(existing);
  return firstFree(slugify(base), (slug) => ids.has(slug) || onDisk(slug));
};

/** A slug stays taken while any package, live or archived, holds its directory. */
const heldIn =
  (...dirs: string[]) =>
  (slug: string): boolean =>
    dirs.some((dir) => existsSync(path.join(dir, slug)));

/**
 * A namesake retired earlier keeps its folder; the newcomer takes the next free name. Never
 * re-slugified: an id past the slug length would lose its suffix and leave itself free.
 */
const archiveTo = (dir: string, id: string): string => path.join(dir, firstFree(id, heldIn(dir)));

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

/** Report a file boot needed but could not read, alongside the packages the store skipped. */
export const noteUnreadable = skip;

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
  active.chat = rows.map((row) => ({ ...row, companyId, id: nextId("nextTeamMessageId") }));
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
          return;
        }
      } catch {
        /* an unreadable TEAM.md has nothing to adopt */
      }
    }
  }
};

// ---- companies -------------------------------------------------------------
/** The company this launch runs; null before one is founded. */
export const getCompany = (): Company | null => maybeCurrent()?.company ?? null;

export const requireCompany = (): Company => current().company;

const patchCompany = (patch: Partial<Company>): Company => {
  const active = current();
  const co = active.company;
  const next = { ...co, ...patch, id: co.id };
  saveCompany(next);
  active.company = next;
  return next;
};

/** patchCompany for what already happened, as recordIn is for a row: the next company write saves it. */
const recordCompany = (patch: Partial<Company>): Company => {
  const active = current();
  const co = active.company;
  const next = { ...co, ...patch, id: co.id };
  try {
    saveCompany(next);
  } finally {
    active.company = next;
  }
  return next;
};

export const setMaxAgents = (maxAgents: number): Company =>
  patchCompany({ maxAgents: Math.max(1, Math.round(maxAgents)) });

export const setAutopilot = (on: boolean): Company => patchCompany({ autopilot: on });

// ---- founder approvals -------------------------------------------------------
// Exact-command approvals survive restart and are consumed once.
// A sign-off belongs to the task it was given for: the continuation that will
// run the command. Company-wide, a grant the agent never used (it reworded the
// command) would wait for anyone who later ran that exact string.
const writeGrants = (grants: Grant[]): void => {
  const active = current();
  atomicWrite(approvalsFile(active.company.id), JSON.stringify(grants, null, 2));
  active.grants = grants;
};

export const grantApproval = (taskId: string, key: string): void => {
  const { grants } = current();
  if (!grants.some((g) => g.taskId === taskId && g.key === key)) {
    writeGrants([...grants, { grantedAt: Date.now(), key, taskId }]);
  }
};

/** Spend the sign-off, if this task holds one for exactly this. */
export const consumeApproval = (taskId: string, key: string): boolean => {
  const { grants } = current();
  const held = grants.find((g) => g.taskId === taskId && g.key === key);
  if (!held) {
    return false;
  }
  writeGrants(grants.filter((g) => g !== held));
  return true;
};

/** A task that has ended takes its unused sign-offs with it. */
export const revokeApprovals = (taskId: string): void => {
  const { grants } = current();
  if (grants.some((g) => g.taskId === taskId)) {
    writeGrants(grants.filter((g) => g.taskId !== taskId));
  }
};

/** A running spend total, kept to a hundredth of a cent so many small runs do not drift. */
const addSpend = (totalUsd: number, costUsd: number): number =>
  Math.round((totalUsd + Math.max(0, costUsd)) * 10_000) / 10_000;

export const recordSpend = (costUsd: number): Company =>
  recordCompany({ spentUsd: addSpend(current().company.spentUsd, costUsd) });

export const setBudget = (budget: Budget): Company => patchCompany({ budget });

export const resetSpend = (): Company => patchCompany({ spentUsd: 0 });

interface MetricsSnapshot {
  users: number | null;
  revenue: number | null;
}

interface MetricsPatch {
  users?: number;
  revenueUsd?: number;
}

/** What a snapshot changes. A null keeps the last reported value through provider failures, and a number that did not move writes nothing. */
const metricsPatch = (
  held: { users: number | null; revenueUsd: number | null },
  snapshot: MetricsSnapshot,
): MetricsPatch => {
  const patch: MetricsPatch = {};
  if (snapshot.users !== null) {
    const users = Math.max(0, Math.round(snapshot.users));
    if (users !== held.users) {
      patch.users = users;
    }
  }
  if (snapshot.revenue !== null) {
    const revenueUsd = Math.round(snapshot.revenue * 100) / 100;
    if (revenueUsd !== held.revenueUsd) {
      patch.revenueUsd = revenueUsd;
    }
  }
  return patch;
};

export const setRealMetrics = (snapshot: MetricsSnapshot): Company => {
  const co = current().company;
  const patch = metricsPatch(co, snapshot);
  return Object.keys(patch).length === 0 ? co : patchCompany(patch);
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
  const list = current().routines;
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

export const listRoutines = (): Routine[] => [...current().routines];

export const markRoutineRun = (routineId: string): void => {
  patchIn(current().routines, routineId, { lastRunAt: Date.now() }, saveRoutine);
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
  instructionsDigest: null,
  lastRunMetrics: null,
  lastShip: null,
  name: input.name,
  persona: input.persona,
  role: input.role,
  runner: input.runner,
  sessionId: null,
  spriteSeed: input.spriteSeed,
  status: "idle",
  title: input.title,
});

export const createEmployee = (hire: FoundingHire & { deskIndex: number }): Employee => {
  const { company, employees: list } = current();
  const input: EmployeeInput = { ...hire, companyId: company.id };
  if (list.length >= company.maxAgents) {
    throw new Error(`the office is at its ${company.maxAgents}-seat cap`);
  }
  const id = uniqueSlug(
    input.name,
    list.map((e) => e.id),
    heldIn(agentsDir(input.companyId), alumniDir(input.companyId)),
  );
  const employee = employeeRecord(input, id);
  mkdirSync(employeeMemoryDir(input.companyId, id), { recursive: true });
  mkdirSync(employeeSessionDir(input.companyId, id), { recursive: true });
  saveEmployee(employee);
  list.push(employee);
  return employee;
};

export const getEmployee = (id: string): Employee | null =>
  maybeCurrent()?.employees.find((employee) => employee.id === id) ?? null;

export const employeeInstructions = (employeeId: string): string => {
  const e = getEmployee(employeeId);
  if (!e) {
    throw new Error(`employee ${employeeId} not found`);
  }
  const { company, products } = current();
  return employeeBody(e, company, products);
};

export const listEmployees = (): Employee[] => [...(current().employees ?? [])];

/** A run started or settled. Memory only: a fresh boot has no live runs, so disk would only lie. */
export const setEmployeeStatus = (id: string, status: Employee["status"]): void => {
  const emp = getEmployee(id);
  if (emp) {
    emp.status = status;
  }
};

/**
 * A run ended: keep the session to resume, what it was told, and where the real numbers
 * stood, for the next brief to measure from.
 */
export const noteRunEnd = (
  id: string,
  session: Pick<Employee, "sessionId" | "instructionsDigest">,
): void => {
  const { active } = c();
  if (!active) {
    return;
  }
  const { revenueUsd, users } = active.company;
  const lastRunMetrics = { at: Date.now(), revenueUsd, users };
  recordIn(active.employees, id, { ...session, lastRunMetrics }, saveRunState);
};

/**
 * Where a released employee's open task goes: to the lead, so an answer or a retry still
 * reaches someone. Unstarted work lands dead, so it holds no bet's slot and waits in the
 * founder's Inbox instead of running on the lead unasked. A run in flight settles on its
 * own; null leaves it be.
 */
const rehomed = (t: Task, leaverName: string, lead: string | null, now: number): Task | null => {
  const deadOnLead = (): Task => ({
    ...t,
    assigneeId: lead,
    ...entering({ kind: "dead", lastError: `${leaverName} was released` }, now),
  });
  switch (t.state.kind) {
    case "todo":
    case "queued": {
      return deadOnLead();
    }
    case "blocked": {
      // a departing lead's blocked proposal would read as the next lead's, and hold every new bet
      return t.betId === null ? deadOnLead() : { ...t, assigneeId: lead };
    }
    case "dead": {
      return { ...t, assigneeId: lead };
    }
    case "running":
    case "done":
    case "superseded": {
      return null;
    }
    // no default
  }
};

/** Hand every open task the leaver holds to the lead, as `rehomed` places it; returns how many moved. */
const handOver = (active: ActiveCompany, leaverId: string, leaverName: string): number => {
  const lead = active.company.leaderId;
  const now = Date.now();
  let moved = 0;
  for (const [i, t] of active.tasks.entries()) {
    const next = t.assigneeId === leaverId ? rehomed(t, leaverName, lead, now) : null;
    if (next) {
      active.tasks[i] = next;
      saveTask(next);
      moved += 1;
    }
  }
  return moved;
};

/** Archive the employee package and hand their open work to the lead; `rehomed` counts it. */
export const archiveEmployee = (
  employeeId: string,
): { employee: Employee; rehomed: number } | null => {
  const emp = getEmployee(employeeId);
  if (!emp) {
    return null;
  }
  moveDir(
    employeeAgentDir(emp.companyId, employeeId),
    archiveTo(alumniDir(emp.companyId), employeeId),
  );
  const active = current();
  const idx = active.employees.findIndex((e) => e.id === employeeId);
  if (idx !== -1) {
    active.employees.splice(idx, 1);
  }
  // the lead left: whoever remains elects one, so the tools keep an owner
  if (active.company.leaderId === employeeId) {
    patchCompany({ leaderId: leadOf(listEmployees()) });
  }
  return { employee: emp, rehomed: handOver(active, employeeId, emp.name) };
};

// ---- products --------------------------------------------------------------
/** The first product's code is the company's workspace/; it inherits the legacy metrics. */
const firstProduct = (co: Company, vercel: VercelBinding | null): Product => ({
  companyId: co.id,
  createdAt: co.createdAt,
  description: co.mission,
  id: uniqueSlug(co.name, [], heldIn(productsDir(co.id), retiredDir(co.id))),
  lastShipAt: null,
  name: co.name,
  revenueUsd: null,
  ships: co.ships,
  users: co.users,
  vercel,
  workspaceDir: companyWorkspace(co.id),
});

export const getProduct = (id: string): Product | null =>
  maybeCurrent()?.products.find((product) => product.id === id) ?? null;

export const requireProduct = (id: string): Product => {
  const p = getProduct(id);
  if (!p) {
    throw new Error(`no product ${id}`);
  }
  return p;
};

export const listProducts = (): Product[] => [...(current().products ?? [])];

const patchProduct = (id: string, patch: Partial<Product>): Product =>
  patchIn(current().products, id, patch, saveProduct);

export const createProduct = (named: ProductDraft): Product => {
  const { company, products: list } = current();
  const input = { ...named, companyId: company.id };
  const id = uniqueSlug(
    input.name,
    list.map((p) => p.id),
    heldIn(productsDir(input.companyId), retiredDir(input.companyId)),
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
  for (const e of listEmployees()) {
    saveEmployee(e);
  }
  return product;
};

export const setProductVercel = (productId: string, vercel: VercelBinding | null): Product =>
  patchProduct(productId, { vercel });

/** Real numbers per product, from the pulse. */
export const setProductMetrics = (productId: string, snapshot: MetricsSnapshot): void => {
  const product = getProduct(productId);
  const patch = product ? metricsPatch(product, snapshot) : {};
  if (Object.keys(patch).length > 0) {
    patchProduct(productId, patch);
  }
};

/** Where work no bet pays for lands: the product that has waited longest for a ship. */
export const attentionProduct = (): Product | null => {
  const products = current().products ?? [];
  return products.toSorted((a, b) => (a.lastShipAt ?? 0) - (b.lastShipAt ?? 0))[0] ?? null;
};

// ---- bets ------------------------------------------------------------------
export const listBets = (): Bet[] => [...(current().bets ?? [])];

export const getBet = (id: string): Bet | null =>
  maybeCurrent()?.bets.find((bet) => bet.id === id) ?? null;

export const allocationPolicy = (): PolicyParams => current().policy ?? DEFAULT_POLICY;

const patchBet = (id: string, patch: Partial<Bet>): Bet =>
  patchIn(current().bets, id, patch, saveBet);

/** What a tool is told when it names a product the company does not have. */
export const noSuchProduct = (productId: string): string =>
  `No product "${productId}" here — the products are ${listProducts()
    .map((p) => p.id)
    .join(", ")}.`;

/**
 * Open a bet. A users bet lands on its own path unless it names one; a path
 * another live bet already covers is refused, since both would count the same
 * visitors.
 */
export const openBet = (
  wager: {
    productId: string;
    title: string;
    hypothesis: string;
    target: number;
    budgetUsd: number;
    windowHours: number;
  } & ({ metric: "users"; landingPath: string | null } | { metric: "revenue" }),
): Bet => {
  const active = current();
  const input = { ...wager, companyId: active.company.id };
  const product = active.products.find((p) => p.id === input.productId);
  if (!product) {
    throw new Error(noSuchProduct(input.productId));
  }
  const id = uniqueSlug(
    input.title,
    active.bets.map((b) => b.id),
    heldIn(betsDir(input.companyId)),
  );
  const bet: Bet = {
    budgetUsd: input.budgetUsd,
    claim:
      input.metric === "users"
        ? { landingPath: input.landingPath ?? defaultLandingPath(id), metric: "users" }
        : { metric: "revenue" },
    companyId: input.companyId,
    createdAt: Date.now(),
    hypothesis: input.hypothesis.trim(),
    id,
    productId: product.id,
    reading: null,
    spentUsd: 0,
    state: { kind: "open" },
    target: input.target,
    title: input.title.trim(),
    windowHours: input.windowHours,
  };
  const rival = active.bets.find((b) => !isClosed(b) && claimsCollide(b, bet));
  if (rival?.claim.metric === "users") {
    throw new Error(
      `"${rival.title}" (${rival.id}) already counts visitors under ${rival.claim.landingPath} on ${product.name}; a bet landing there too could not be told apart from it. Leave landingPath out to get a path of its own.`,
    );
  }
  saveBet(bet);
  active.bets.push(bet);
  return bet;
};

/** What the pulse read for a live bet; a null keeps the last reading through a provider failure. */
export const setBetReading = (betId: string, reading: number | null): void => {
  const bet = getBet(betId);
  if (bet && !isClosed(bet) && reading !== null && reading !== bet.reading) {
    patchBet(betId, { reading });
  }
};

export const recordBetSpend = (betId: string, costUsd: number): void => {
  const bet = getBet(betId);
  if (bet) {
    recordIn(current().bets, betId, { spentUsd: addSpend(bet.spentUsd, costUsd) }, saveBet);
  }
};

/** Runs queued or running per bet: each will bill it, and none has yet. */
export const runsInFlight = (): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const t of current().tasks) {
    if (t.betId !== null && (t.state.kind === "queued" || t.state.kind === "running")) {
      counts.set(t.betId, (counts.get(t.betId) ?? 0) + 1);
    }
  }
  return counts;
};

/**
 * Dead-letter the matching work that has not started; the founder can still
 * revive it from the Inbox. A running task finishes its run, and dies if that
 * run fails, parks (`failTask`, `parkTask`) or never settles before the app
 * restarts (`recoverInterrupted`). Dead work keeps the error it died of.
 */
const deadLetter = (match: (t: Task) => boolean, reason: string, now: number): void => {
  const { tasks } = current();
  for (const t of tasks.filter(match)) {
    const { kind } = t.state;
    if (kind === "todo" || kind === "queued" || kind === "blocked") {
      patchIn(tasks, t.id, entering({ kind: "dead", lastError: reason }, now), saveTask);
    }
  }
};

const BET_MEASURING = "bet is measuring";
const BET_CLOSED = "bet closed";

/** Why the bet takes no more runs, as its dead letters say; null while it is open, or for work on none. */
const stoppedBetReason = (bet: Bet | null): string | null => {
  if (!bet || bet.state.kind === "open") {
    return null;
  }
  return bet.state.kind === "measuring" ? BET_MEASURING : BET_CLOSED;
};

const retune = (active: ActiveCompany): void => {
  const next = dream(active.policy, active.bets);
  if (next !== active.policy) {
    atomicWrite(policyFile(active.company.id), JSON.stringify(next, null, 2));
    active.policy = next;
  }
};

/** The work is shipped: stop spending and let the number answer. */
export const measureBet = (betId: string, now: number): Bet => {
  const bet = getBet(betId);
  if (!bet || bet.state.kind !== "open") {
    throw new Error(`no open bet "${betId}"`);
  }
  const measuring = patchBet(betId, { state: { kind: "measuring", until: windowEnd(bet, now) } });
  // work waiting on the founder stays: that step may be the one that moves the number
  deadLetter((t) => t.betId === betId && t.state.kind !== "blocked", BET_MEASURING, now);
  return measuring;
};

const closeAsKilled = (bet: Bet, reason: string, now: number): Bet =>
  patchBet(bet.id, { state: { closedAt: now, kind: "killed", moved: bet.reading, reason } }) ?? bet;

/** Someone gives up on a bet before its window does. */
export const killBet = (betId: string, reason: string, now: number): Bet => {
  const bet = getBet(betId);
  if (!bet || isClosed(bet)) {
    throw new Error(`no live bet "${betId}"`);
  }
  const killed = closeAsKilled(bet, reason, now);
  deadLetter((t) => t.betId === betId, "bet killed", now);
  retune(current());
  return killed;
};

/** Judge every live bet against the real numbers; returns the ones whose state changed. */
export const judgeBets = (now: number): Bet[] => {
  const active = current();
  const changed: Bet[] = [];
  for (const bet of active.bets) {
    const state = judge(bet, now);
    if (state !== bet.state) {
      changed.push(patchBet(bet.id, { state }));
    }
  }
  const closed = new Set(changed.filter(isClosed).map((b) => b.id));
  if (closed.size > 0) {
    deadLetter((t) => t.betId !== null && closed.has(t.betId), BET_CLOSED, now);
    retune(active);
  }
  return changed;
};

/** How many ship summaries a brief lists. */
const RECENT_SHIPS = 6;
const RecentShipsSchema = z.array(z.string());

export const recentShips = (): readonly string[] => current().recentShips ?? [];

export const recordShip = (productId: string | null, summary: string): void => {
  const active = current();
  recordCompany({ ships: active.company.ships + 1 });
  const product = productId === null ? null : getProduct(productId);
  if (product) {
    recordIn(
      active.products,
      product.id,
      { lastShipAt: Date.now(), ships: product.ships + 1 },
      saveProduct,
    );
  }
  // the counters are the record; the brief's list follows them
  const ships = [...active.recentShips, summary].slice(-RECENT_SHIPS);
  try {
    atomicWrite(recentShipsFile(active.company.id), JSON.stringify(ships, null, 2));
  } finally {
    active.recentShips = ships;
  }
};

// ---- the company room ------------------------------------------------------
export const postTeamMessage = (fromEmployeeId: string | null, text: string): TeamMessage => {
  const active = current();
  const msg: TeamMessage = {
    companyId: active.company.id,
    createdAt: Date.now(),
    fromEmployeeId,
    text,
  };
  const ring = active.chat;
  const stored: TeamMessage = { ...msg, id: nextId("nextTeamMessageId") };
  ring.push(stored);
  if (ring.length > TEAM_CHAT_RING) {
    ring.splice(0, ring.length - TEAM_CHAT_RING);
  }
  appendJsonl(chatFile(active.company.id), msg);
  return stored;
};

export const recentTeamMessages = (limit = 20, since = 0): TeamMessage[] => {
  const ring = current().chat ?? [];
  const filtered = since > 0 ? ring.filter((m) => m.createdAt > since) : ring;
  return filtered.slice(-limit);
};

// ---- tasks -----------------------------------------------------------------
export const createTask = (brief: {
  productId?: string | null;
  betId?: string | null;
  origin: TaskOrigin;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  assigneeId?: string | null;
}): Task => {
  const { company, tasks: list } = current();
  const t = { ...brief, companyId: company.id };
  const id = uniqueSlug(
    t.title,
    list.map((x) => x.id),
    heldIn(tasksDir(t.companyId), shippedDir(t.companyId)),
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
    origin: t.origin,
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
  maybeCurrent()?.tasks.find((task) => task.id === id) ?? null;

const newestFirst = (a: Task, b: Task): number => b.createdAt - a.createdAt;

/** Shipped work and answered asks: shelved in shipped/, never acted on again. */
const HISTORY: ReadonlySet<TaskStatus> = new Set(["done", "superseded"]);
const isHistory = (t: Task): boolean => HISTORY.has(t.state.kind);

/** The company's open queue: everything not yet history, newest first. */
export const listOpenTasks = (): Task[] => (current().tasks ?? []).toSorted(newestFirst);

/** Open tasks by assignee and status, newest first. History is the shipping log's. */
export const queryTasks = (query: {
  assigneeId?: string;
  status?: readonly OpenTaskStatus[];
}): Task[] => {
  const { assigneeId, status } = query;
  return listOpenTasks()
    .filter((t) => assigneeId === undefined || t.assigneeId === assigneeId)
    .filter((t) => status === undefined || status.some((s) => s === t.state.kind));
};

/** Everything the company has finished, newest first. Read from disk the first time it is asked for. */
export const listShippedTasks = (): Task[] => {
  const active = current();
  const companyId = active.company.id;
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

/** A shipping log line's summary; the brief a task ran on stays on disk. */
const SHIP_LINE_CHARS = 1500;

/** Every ship with something to say, newest first: the Products panel's log. */
export const shippingLog = (): ShipLine[] =>
  listShippedTasks()
    .filter(taskIn("done"))
    .flatMap(({ assigneeId, completedAt, createdAt, id, productId, state, title }) =>
      state.summary
        ? [
            {
              assigneeId,
              completedAt: completedAt ?? createdAt,
              id,
              productId,
              summary: state.summary.slice(0, SHIP_LINE_CHARS),
              title,
            },
          ]
        : [],
    )
    .toSorted((a, b) => b.completedAt - a.completedAt);

export const openTasksFor = (employeeId: string): Task[] =>
  maybeCurrent()?.tasks.filter((task) => task.assigneeId === employeeId) ?? [];

const TASK_PRIORITY_ORDER = { high: 0, low: 2, medium: 1 } satisfies Record<TaskPriority, number>;

/** Queued tasks eligible to start now (a backoff retry waits for nextAttemptAt). */
export const listQueuedTasks = (): Task[] => {
  const now = Date.now();
  const out = (maybeCurrent()?.tasks ?? []).filter((task) => {
    const { state } = task;
    return state.kind === "queued" && (state.nextAttemptAt === null || state.nextAttemptAt <= now);
  });
  return out.toSorted(
    (a, b) =>
      TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority] ||
      a.createdAt - b.createdAt,
  );
};

const patchTask = (id: string, patch: Partial<Task>): Task =>
  patchIn(current().tasks, id, patch, saveTask);

/** How a task leaves a run that has ended, or an ask that was answered: it happened, saved or not. */
const recordTask = (id: string, patch: Partial<Task>): Task =>
  recordIn(current().tasks, id, patch, saveTask);

/** How a run can leave its task: shipped, or waiting on the founder. Only an answer supersedes one. */
type Settled = Extract<TaskState, { kind: "done" | "blocked" }>;

/** How much of a ship's summary a dialogue quotes back to its author. */
const LAST_SHIP_CHARS = 500;

/** Kept in run-state so a dialogue can offer to build on it without reading the shipping log. */
const noteShip = (t: Task): void => {
  // a run can settle after its employee was released
  if (t.state.kind !== "done" || !t.state.summary || !t.assigneeId || !getEmployee(t.assigneeId)) {
    return;
  }
  const lastShip = {
    summary: t.state.summary.slice(0, LAST_SHIP_CHARS),
    taskId: t.id,
    title: t.title,
  };
  recordIn(current().employees, t.assigneeId, { lastShip }, saveRunState);
};

// Persist before shelving so boot can recover a crash between the two writes.
const close = (
  taskId: string,
  state: Settled | Extract<TaskState, { kind: "superseded" }>,
): void => {
  const t = recordTask(taskId, entering(state, Date.now()));
  if (!isHistory(t)) {
    return;
  }
  try {
    shelve(t);
  } catch (error) {
    console.error(`could not shelve ${t.id}: ${errorMessage(error)}`);
    return;
  }
  const active = current();
  const idx = active.tasks.findIndex((task) => task.id === t.id);
  if (idx !== -1) {
    active.tasks.splice(idx, 1);
  }
  active.shipped?.push(t);
  noteShip(t);
};

const heldBy = (t: Task | null, runId: string): Task | null =>
  t && t.state.kind === "running" && t.state.runId === runId ? t : null;

/** Null on a claim conflict or for anyone off the roster; reviving a dead task resets its retry count. */
export const claimTask = (taskId: string, employeeId: string): Task | null => {
  const t = getTask(taskId);
  if (!t || !getEmployee(employeeId)) {
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
  return patchTask(taskId, entering({ kind: "running", runId }, Date.now()));
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
      ? { ...t, attempts: verdict.attempts, ...entering({ kind: "dead", lastError }, now) }
      : {
          ...t,
          attempts: verdict.attempts,
          state: { kind: "queued", lastError, nextAttemptAt: verdict.retryAt },
        };
  return { task, verdict };
};

type Died = Extract<FailureVerdict, { kind: "dead" }>;

/** A run whose bet stopped taking work while it ran ends its task instead of requeueing it; null while the bet is open. */
const diedWithBet = (t: Task, attempts: number): Died | null => {
  const reason = stoppedBetReason(t.betId === null ? null : getBet(t.betId));
  if (reason === null) {
    return null;
  }
  recordTask(t.id, { attempts, ...entering({ kind: "dead", lastError: reason }, Date.now()) });
  return { attempts, kind: "dead" };
};

/** A run failed: the task takes its next verdict. Only the owning run may; null when it no longer holds the lock. */
export const failTask = (taskId: string, runId: string, error: string): FailureVerdict | null => {
  const t = heldBy(getTask(taskId), runId);
  if (!t) {
    return null;
  }
  const next = failed(t, error);
  const died = diedWithBet(t, next.verdict.attempts);
  if (died) {
    return died;
  }
  recordTask(taskId, next.task);
  return next.verdict;
};

/**
 * A run parked through no fault of the task — a usage limit, the app quitting: back on
 * the queue from `until`, no attempt burned. Only the owning run may; null when it no
 * longer holds the lock.
 */
export const parkTask = (
  taskId: string,
  runId: string,
  until: number,
  lastError: string,
): { kind: "parked" } | Died | null => {
  const t = heldBy(getTask(taskId), runId);
  if (!t) {
    return null;
  }
  const died = diedWithBet(t, t.attempts);
  if (died) {
    return died;
  }
  recordTask(taskId, { state: { kind: "queued", lastError, nextAttemptAt: until } });
  return { kind: "parked" };
};

/**
 * Hand the answer to a continuation on the same employee and session, then
 * shelve the ask as superseded by it. In that order: a crash between the two
 * writes leaves an ask to answer again, never an answer nobody carries.
 */
export const resolveBlockedWithAnswer = (taskId: string, answer: string): Task | null => {
  const t = getTask(taskId);
  if (!t || t.state.kind !== "blocked" || !t.assigneeId) {
    return null;
  }
  const next = createTask({
    betId: t.betId,
    origin: t.origin,
    productId: t.productId,
    ...continuationBrief(t, t.state.ask, answer),
    assigneeId: t.assigneeId,
    priority: "high",
  });
  close(taskId, { by: next.id, kind: "superseded" });
  return next;
};

/** The product an employee is on: their latest task's, else the company's first. */
export const productOfEmployee = (employeeId: string): Product | null => {
  const emp = getEmployee(employeeId);
  if (!emp) {
    return null;
  }
  const [latest] = openTasksFor(employeeId).toSorted(newestFirst);
  const fromTask = latest?.productId ? getProduct(latest.productId) : null;
  return fromTask ?? maybeCurrent()?.products[0] ?? null;
};

/**
 * Retire a product: its live bets die with it, its open work is dead-lettered,
 * and its package moves to retired/ whole, with its code beside PRODUCT.md even
 * when that lived outside the package, as the first product's does. The last
 * product cannot go — a company with none would be handed a fresh first product
 * at the next boot. Nor can one a teammate's run is working in: the move would
 * pull the tree out from under it, and a retry would land as company-level
 * work. `by` is the employee retiring it, whose own run is exempt; null is the
 * founder. Returns the bets it took down.
 */
export const killProduct = (productId: string, reason: string, by: string | null): Bet[] => {
  const product = requireProduct(productId);
  const active = current();
  if (active.products.length === 1) {
    throw new Error(
      `${product.name} is the only product — start its successor with create_product first.`,
    );
  }
  const busy = active.tasks.find(
    (t) => t.productId === productId && t.state.kind === "running" && t.assigneeId !== by,
  );
  if (busy) {
    const runner = busy.assigneeId === null ? null : getEmployee(busy.assigneeId);
    throw new Error(
      `${runner?.name ?? "A teammate"} is mid-run on ${product.name} — kill its bets so no new work lands there, then retire it once they're idle.`,
    );
  }
  const pkg = path.join(productsDir(product.companyId), productId);
  const archive = archiveTo(retiredDir(product.companyId), productId);
  moveDir(pkg, archive);
  const outside = product.workspaceDir !== productWorkspace(product.companyId, productId);
  if (outside && existsSync(product.workspaceDir)) {
    try {
      moveDir(product.workspaceDir, path.join(archive, "workspace"));
    } catch (error) {
      moveDir(archive, pkg);
      throw error;
    }
  }
  const now = Date.now();
  const killed = active.bets
    .filter((b) => b.productId === productId && !isClosed(b))
    .map((bet) => closeAsKilled(bet, `product retired: ${reason}`, now));
  if (killed.length > 0) {
    retune(active);
  }
  deadLetter((t) => t.productId === productId, "product retired", now);
  active.products.splice(active.products.indexOf(product), 1);
  for (const e of active.employees) {
    saveEmployee(e, { onlyIfChanged: true });
  }
  return killed;
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
    workspaceDir: companySharedDir(id),
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
    mkdirSync(staged(companySharedDir(id)), { recursive: true });
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

interface FoundSave {
  company: Company;
  /** The format it was last written in; lower than SAVE_FORMAT means boot still has adopting to do. */
  format: number;
}

const readCompanies = (): FoundSave[] => {
  const companies: FoundSave[] = [];
  for (const entry of safeReaddir(ROOT_DIR)) {
    if (entry.startsWith(".")) {
      continue;
    }
    const file = companyFile(entry);
    if (!existsSync(file)) {
      continue;
    }
    try {
      const doc = parseDoc(readFileSync(file, "utf-8"));
      const company = docToCompany(doc);
      if (company.id !== entry) {
        throw new Error("company slug does not match its directory");
      }
      companies.push({ company, format: formatOf(doc) });
    } catch (error) {
      skip("company", file, error);
    }
  }
  return companies;
};

/** A run the last launch never saw settle: it dies with a bet that stopped taking work, else counts as failed. */
const recoverInterrupted = (task: Task, bets: readonly Bet[], now: number): Task => {
  const stopped = stoppedBetReason(bets.find((bet) => bet.id === task.betId) ?? null);
  if (stopped !== null) {
    return { ...task, ...entering({ kind: "dead", lastError: stopped }, now) };
  }
  return task.assigneeId
    ? failed(task, "Interrupted by app restart").task
    : { ...task, state: { kind: "todo" } };
};

/** Recover the active company's interrupted runs and shelve its unshelved work. */
const settleLoadedTasks = (company: Company, tasks: Task[], bets: readonly Bet[]): Task[] => {
  const now = Date.now();
  for (const [i, task] of tasks.entries()) {
    if (task.state.kind !== "running") {
      continue;
    }
    const recovered = recoverInterrupted(task, bets, now);
    tasks[i] = recovered;
    saveTask(recovered);
  }
  for (const task of tasks.filter(isHistory)) {
    try {
      shelve(task);
    } catch (error) {
      skip("task", taskFile(company.id, task.id), error);
    }
  }
  return tasks.filter((task) => !isHistory(task));
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
  active.bets = loadPackages(
    "bet",
    betsDir(company.id),
    (slug) => betFile(company.id, slug),
    (doc) => docToBet(doc, company.id),
  ).toSorted(byAge);
  const tasks = loadPackages(
    "task",
    tasksDir(company.id),
    (slug) => taskFile(company.id, slug),
    (doc) => docToTask(doc, company.id),
  ).toSorted(byAge);
  active.tasks = settleLoadedTasks(company, tasks, active.bets);
  active.products = loadPackages(
    "product",
    productsDir(company.id),
    (slug) => productFile(company.id, slug),
    (doc) => docToProduct(doc, company.id),
  ).toSorted(byAge);
  active.policy = readJsonFile(policyFile(company.id), PolicyParamsSchema) ?? DEFAULT_POLICY;
  active.grants = readJsonFile(approvalsFile(company.id), z.array(GrantSchema)) ?? [];
  active.routines = loadPackages(
    "routine",
    routinesDir(company.id),
    (slug) => routineFile(company.id, slug),
    (doc) => docToRoutine(doc, company.id),
  );
  loadRecentChat(active);
  active.sinceLastLook = readJsonFile(sinceLastLookFile(company.id), DigestSchema);
  active.recentShips = readJsonFile(recentShipsFile(company.id), RecentShipsSchema) ?? [];
  return active;
};

/** A company always has a product to work on; one that lost its last is given its mission back as one. */
const ensureFirstProduct = (active: ActiveCompany, vercel: VercelBinding | null): void => {
  if (active.products.length === 0) {
    const first = firstProduct(active.company, vercel);
    mkdirSync(first.workspaceDir, { recursive: true });
    active.products.push(first);
    saveProduct(first);
  }
};

/** The Vercel binding a save from before products kept on the company, for the first product to hold. */
const legacyVercel = (companyId: string): VercelBinding | null => {
  const legacy = readMetricsConfig(companyId)?.vercel;
  if (!legacy) {
    return null;
  }
  return {
    projectId: legacy.projectId,
    projectName: legacy.projectName ?? legacy.projectId,
    teamId: legacy.teamId ?? null,
  };
};

/** Format 1 shelved an answered ask as done, its summary the answer: relabel it as the history it is. */
const adoptAnsweredAsks = (active: ActiveCompany): void => {
  const companyId = active.company.id;
  active.shipped = listShippedTasks().map((t) => {
    if (t.state.kind !== "done" || !t.state.summary?.startsWith("Founder answered: ")) {
      return t;
    }
    const answered: Task = { ...t, state: { by: null, kind: "superseded" } };
    atomicWrite(shippedTaskFile(companyId, t.id), serializeDoc(taskToDoc(answered)));
    return answered;
  });
};

/**
 * Format 2 kept each product's absolute workspace path, which a copied save
 * still pointed back through. The codec reads a product without the new key
 * as the first, coding in the company's workspace/; the old path's tail says which had their own.
 */
const adoptProductWorkspaces = (active: ActiveCompany): void => {
  const { id } = active.company;
  active.products = active.products.map((p) => {
    const legacy = optStr(
      parseDoc(readTextIfPresent(productFile(id, p.id)) ?? "").metadata,
      "workspaceDir",
    );
    const adopted: Product =
      legacy !== null && legacy.endsWith(path.join("products", p.id, "workspace"))
        ? { ...p, workspaceDir: productWorkspace(id, p.id) }
        : p;
    saveProduct(adopted);
    return adopted;
  });
};

/**
 * An older build's release left the leaver's asks and dead letters on their id, which no
 * claim reaches: an answer queued a continuation nobody runs. Whoever an open task still
 * names off the roster is released now, known only by that id.
 */
const adoptOrphanedTasks = (active: ActiveCompany): void => {
  const roster = new Set(active.employees.map((e) => e.id));
  const leavers = new Set(
    active.tasks.flatMap((t) =>
      t.assigneeId === null || roster.has(t.assigneeId) ? [] : [t.assigneeId],
    ),
  );
  for (const leaver of leavers) {
    handOver(active, leaver, leaver);
  }
};

/**
 * Bring a save written in format `from` up to this one, once: saveCompany
 * then stamps it, and none of this runs for it again. A step written for
 * format N runs only for saves stamped below it. Everything that reads an
 * old shape of the company's files belongs here, so it has a date it can be
 * deleted on; tolerant field reads inside the codecs are not migrations.
 */
const adoptOlderSave = (active: ActiveCompany, from: number): void => {
  const { id } = active.company;
  if (from < 1) {
    adoptLegacyTeam(active.company);
    loadRecentChat(active);
    for (const e of active.employees) {
      if (e.sessionId !== null) {
        // AGENTS.md is rewritten without it at the end of this boot
        saveRunState(e);
      }
    }
    if (active.products.length === 0) {
      const vercel = legacyVercel(id);
      ensureFirstProduct(active, vercel);
      if (vercel !== null) {
        writeMetricsConfig(id, { vercel: undefined });
      }
    }
    dropRetiredRoutines(active);
  }
  if (from < 2) {
    adoptAnsweredAsks(active);
  }
  if (from < 3) {
    adoptProductWorkspaces(active);
    adoptOrphanedTasks(active);
  }
  saveCompany(active.company);
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
  const [newest] = companies.toSorted(
    (a, b) => b.company.createdAt - a.company.createdAt || a.company.id.localeCompare(b.company.id),
  );
  if (!newest) {
    return lastLoad;
  }
  const { company, format } = newest;
  try {
    const active = loadActiveCompany(company);
    cache.active = active;
    // three different jobs, in this order: adopt an older format, repair what must always hold, then serve
    if (format < SAVE_FORMAT) {
      adoptOlderSave(active, format);
    }
    ensureFirstProduct(active, null);
    mkdirSync(company.workspaceDir, { recursive: true });
    if (active.employees.length > 0 && !active.employees.some((e) => e.id === company.leaderId)) {
      active.company = { ...company, leaderId: leadOf(active.employees) };
      saveCompany(active.company);
    }
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
  atomicWrite(sinceLastLookFile(active.company.id), JSON.stringify(next, null, 2));
  active.sinceLastLook = next;
};

/** The founder has the office in view as of `at`: what came before is seen, and the count starts over. */
export const markSeen = (at: number): void => {
  saveSinceLastLook(current(), emptyDigest(at));
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
export const takeDigest = (): Digest | null => {
  const since = current().sinceLastLook;
  markSeen(Date.now());
  return since;
};
