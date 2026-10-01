import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { appendJsonl, atomicWrite, moveDir, readJsonFile, readJsonlTail } from "@/main/lib/fs";
import { report } from "@/main/lib/report";
import {
  ROOT_DIR,
  TOOL_CACHE_DIR,
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
  tasksDir,
  taskFile,
  shippedDir,
  shippedTaskFile,
  productsDir,
  productFile,
  productWorkspace,
  linkFile,
  linksDir,
  listingsDir,
  listingFile,
  ordersDir,
  orderFile,
  ordersCursorFile,
  unrecordedLinksFile,
  retiredDir,
  betsDir,
  betFile,
  policyFile,
  routinesDir,
  routineFile,
  chatFile,
  legacyTeamsDir,
} from "@/main/paths";
import { parseDoc, serializeDoc, slugify, optStr } from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";
import { z } from "zod";
import { continuationBrief, continuationTitle, isRoutineBrief } from "@/main/prompts/briefs";
import { RETIRED_ROUTINES, REWORDED_ROUTINES, defaultRoutines } from "@/main/prompts/routines";
import type { RoutineDefinition } from "@/main/prompts/routines";
import { betToDoc, docToBet } from "@/main/store/bet-codec";
import { docToProduct, productToDoc } from "@/main/store/product-codec";
import { docToTask, taskToDoc } from "@/main/store/task-codec";
import {
  NewerSaveError,
  SAVE_FORMAT,
  companyToDoc,
  docToCompany,
  formatOf,
} from "@/main/store/company-codec";
import { docToEmployee, employeeBody, employeeToDoc } from "@/main/store/employee-codec";
import { docToRoutine, routineToDoc } from "@/main/store/routine-codec";
import { readMetricsConfig, writeMetricsConfig } from "@/main/store/metrics-config";
import {
  DEFAULT_POLICY,
  MAX_LIVE_BETS_PER_PRODUCT,
  MAX_LIVE_PRODUCTS,
  PolicyParamsSchema,
  claimsCollide,
  defaultLandingPath,
  dream,
  holdsItsPath,
  isClosed,
  judge,
  namedPathRefusal,
  portfolioHasRoom,
  productHasRoom,
  windowEnd,
} from "@/shared/bets";
import type { Bet, BetClaim, BetState, PolicyParams } from "@/shared/bets";
import { errorMessage } from "@/shared/errors";
import { parseJson } from "@/shared/json";
import { ListingSchema } from "@/shared/listing";
import type { Listing } from "@/shared/listing";
import { OrderSchema } from "@/shared/order";
import { ChargeLinkSchema } from "@/shared/payment-link";
import type { ChargeLink, CompanyLink, LinkState } from "@/shared/payment-link";
import type { Order, Sale } from "@/shared/order";
import { RefusalError } from "@/shared/refusal";
import { emptyDigest, foldDigest } from "@/main/store/digest";
import { DigestSchema } from "@/shared/digest";
import type { Digest } from "@/shared/digest";
import type {
  ActionAsk,
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
  Speaker,
  Task,
  TaskIn,
  TaskOrigin,
  TaskPriority,
  TaskState,
  TaskStatus,
  TeamMessage,
  VercelBinding,
} from "@/shared/domain";
import {
  DEFAULT_MAX_AGENTS,
  LastShipSchema,
  ProductDraftSchema,
  RunMetricsSchema,
  SpeakerSchema,
  UNNAMED_PRODUCT_DESCRIPTION,
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
  /** Every print-on-demand item ever listed, a retired product's too: its orders still ship. */
  listings: Listing[];
  /** Listing ids handed out whose listing Stripe is still making: no namesake listed meanwhile may take one. */
  pendingListings: Set<string>;
  /** Every create_payment_link link, a retired product's too: its buyers may still be owed a delivery. */
  links: ChargeLink[];
  /** Every paid checkout on the company's links, a retired product's too: a print still ships, a delivery is still owed. */
  orders: Order[];
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
  links: [],
  listings: [],
  orders: [],
  pendingListings: new Set(),
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

// ---- run state --------------------------------------------------------------
/** What a run leaves for the next one; kept out of AGENTS.md so the instructions only change when they do. */
const RunStateSchema = z.object({
  // defaulted like lastShip; a file without it reads as never told, so the next run sends them once
  instructionsDigest: z.string().nullable().default(null),
  lastRunMetrics: RunMetricsSchema.nullable(),
  // defaulted: a file without it must still parse, or its session would be dropped with it
  lastShip: LastShipSchema.nullable().default(null),
  sessionId: z.string().nullable(),
  // a file without it names no folder its session began in, so that session is never resumed
  sessionWorkspace: z.string().nullable().default(null),
});

const saveRunState = (e: Employee): void => {
  const state: z.infer<typeof RunStateSchema> = {
    instructionsDigest: e.instructionsDigest,
    lastRunMetrics: e.lastRunMetrics,
    lastShip: e.lastShip,
    sessionId: e.session?.id ?? null,
    sessionWorkspace: e.session?.workspace ?? null,
  };
  atomicWrite(employeeRunStateFile(e.companyId, e.id), JSON.stringify(state, null, 2));
};

const withRunState = (e: Employee): Employee => {
  const state = readJsonFile(employeeRunStateFile(e.companyId, e.id), RunStateSchema);
  if (state === null) {
    return e;
  }
  const { instructionsDigest, lastRunMetrics, lastShip, sessionId, sessionWorkspace } = state;
  const session =
    sessionId === null || sessionWorkspace === null
      ? null
      : { id: sessionId, workspace: sessionWorkspace };
  return { ...e, instructionsDigest, lastRunMetrics, lastShip, session };
};

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

/** Shipped work, answered asks and dropped work: shelved in shipped/, never acted on again. */
const HISTORY: ReadonlySet<TaskStatus> = new Set(["done", "superseded", "dropped"]);
const isHistory = (t: Task): boolean => HISTORY.has(t.state.kind);

/** Move a task just saved as history out of the open queue; one the move fails stays for boot to shelve. */
const shelveClosed = (t: Task): boolean => {
  try {
    shelve(t);
  } catch (error) {
    report(`shelve ${t.id}`, error);
    return false;
  }
  const active = current();
  const idx = active.tasks.findIndex((task) => task.id === t.id);
  if (idx !== -1) {
    active.tasks.splice(idx, 1);
  }
  active.shipped?.push(t);
  return true;
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
  lastLoad.skipped.push({
    error: errorMessage(cause),
    kind,
    newerBuild: cause instanceof NewerSaveError,
    path: file,
  });
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

/** Whether `dir` holds any package, read or skipped: one boot skipped is the load report's to name, never replaced. */
const holdsPackage = (dir: string, fileFor: (slug: string) => string): boolean =>
  safeReaddir(dir).some((slug) => existsSync(fileFor(slug)));

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

/** Each `<id>.json` of `dir` that `schema` reads; one naming another id is skipped. */
const loadRecords = <T extends { createdAt: number; id: string }>(
  kind: LoadSkip["kind"],
  dir: string,
  schema: z.ZodType<T>,
): T[] =>
  safeReaddir(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const file = path.join(dir, name);
      try {
        const record = schema.parse(parseJson(readFileSync(file, "utf-8")));
        if (`${record.id}.json` !== name) {
          throw new Error(`${kind} does not match its file's name`);
        }
        return [record];
      } catch (error) {
        skip(kind, file, error);
        return [];
      }
    })
    .toSorted(byAge);

const TEAM_CHAT_RING = 200;

// One chat.jsonl line, as postTeamMessage persists it (id and companyId re-assigned on load).
const PersistedTeamMessageSchema = z.object({
  createdAt: z.number(),
  from: SpeakerSchema,
  text: z.string(),
});
type PersistedTeamMessage = z.infer<typeof PersistedTeamMessageSchema>;

/**
 * A chat.jsonl line of either shape, for adopting an older save only. Format 4
 * and older named the speaker by employee id, null for the founder and the
 * office alike; null reads as the founder, as the room always showed it.
 */
const AdoptedTeamMessageSchema = z.union([
  PersistedTeamMessageSchema,
  z
    .object({ createdAt: z.number(), fromEmployeeId: z.string().nullable(), text: z.string() })
    .transform(({ fromEmployeeId, ...row }): PersistedTeamMessage => ({
      ...row,
      from:
        fromEmployeeId === null ? { kind: "founder" } : { id: fromEmployeeId, kind: "employee" },
    })),
]);

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
    const rows: PersistedTeamMessage[] = [];
    for (const slug of slugs) {
      rows.push(
        ...readJsonlTail(path.join(dir, slug, "chat.jsonl"), AdoptedTeamMessageSchema, 10_000),
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

export const holdsApproval = (taskId: string): boolean =>
  current().grants.some((g) => g.taskId === taskId);

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

/** A restart ends a run as its settle would: a task no longer waiting to run keeps no sign-off. */
const dropEndedGrants = (active: ActiveCompany): void => {
  const ended = new Set(
    active.tasks
      .filter((t) => t.state.kind === "dead" || t.state.kind === "blocked")
      .map((t) => t.id),
  );
  const kept = active.grants.filter((g) => !ended.has(g.taskId));
  if (kept.length < active.grants.length) {
    writeGrants(kept);
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
  session: null,
  spriteSeed: input.spriteSeed,
  status: "idle",
  title: input.title,
});

export const createEmployee = (hire: FoundingHire & { deskIndex: number }): Employee => {
  const { company, employees: list } = current();
  const input: EmployeeInput = { ...hire, companyId: company.id };
  if (list.length >= company.maxAgents) {
    throw new RefusalError(`the office is at its ${company.maxAgents}-seat cap`);
  }
  const id = uniqueSlug(
    input.name,
    list.map((e) => e.id),
    heldIn(agentsDir(input.companyId), alumniDir(input.companyId)),
  );
  const employee = employeeRecord(input, id);
  mkdirSync(employeeMemoryDir(input.companyId, id), { recursive: true });
  saveEmployee(employee);
  list.push(employee);
  return employee;
};

export const getEmployee = (id: string): Employee | null =>
  maybeCurrent()?.employees.find((employee) => employee.id === id) ?? null;

export const employeeInstructions = (employeeId: string): string => {
  const e = getEmployee(employeeId);
  if (!e) {
    throw new RefusalError(`employee ${employeeId} not found`);
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
  session: Pick<Employee, "session" | "instructionsDigest">,
): void => {
  const { active } = c();
  if (!active) {
    return;
  }
  const { revenueUsd, users } = active.company;
  const lastRunMetrics = { at: Date.now(), revenueUsd, users };
  recordIn(active.employees, id, { ...session, lastRunMetrics }, saveRunState);
};

const newestFirst = (a: Task, b: Task): number => b.createdAt - a.createdAt;

/** Everything the company shelved as history. Read from disk the first time it is asked for. */
const shippedOf = (active: ActiveCompany): Task[] => {
  const companyId = active.company.id;
  active.shipped ??= loadPackages(
    "task",
    shippedDir(companyId),
    (slug) => shippedTaskFile(companyId, slug),
    (doc) => docToTask(doc, companyId),
  );
  return active.shipped;
};

/** Everything shelved as history, newest first. */
export const listShippedTasks = (): Task[] => shippedOf(current()).toSorted(newestFirst);

/** The continuations carrying the founder's answers to the bet's asks, among `history`. */
const answeredIn = (history: readonly Task[], betId: string): ReadonlySet<string> =>
  new Set(
    history.flatMap((t) =>
      t.betId === betId && t.state.kind === "superseded" && t.state.by !== null ? [t.state.by] : [],
    ),
  );

/** The continuations carrying the founder's answers to the bet's asks: work that no longer waits on them, but carries their step. */
const answeredOn = (betId: string): ReadonlySet<string> => answeredIn(shippedOf(current()), betId);

const RELEASED = " was released";

/**
 * Where a released employee's open task goes. An ask a bet funds, the founder's answer to
 * one (`answered`, with any sign-off it holds), or a dead letter, goes to the lead, so an
 * answer or a retry still reaches someone. Other unstarted work is dropped, so it holds no
 * bet's slot and never runs on the lead unasked. A run in flight settles on its own; null
 * leaves it be.
 */
const rehomed = (
  t: Task,
  leaverName: string,
  lead: string | null,
  answered: boolean,
  now: number,
): Task | null => {
  const dropped = (): Task => ({
    ...t,
    ...entering({ kind: "dropped", reason: `${leaverName}${RELEASED}` }, now),
  });
  switch (t.state.kind) {
    case "todo":
    case "queued": {
      return answered ? { ...t, assigneeId: lead } : dropped();
    }
    case "blocked": {
      // a departing lead's blocked proposal would read as the next lead's, and hold every new bet
      return t.betId === null ? dropped() : { ...t, assigneeId: lead };
    }
    case "dead": {
      return { ...t, assigneeId: lead };
    }
    case "running":
    case "done":
    case "superseded":
    case "dropped": {
      return null;
    }
    // no default
  }
};

interface HandedOver {
  /** Now the lead's. */
  rehomed: number;
  dropped: number;
}

/** Hand every open task the leaver holds to the lead or to history, as `rehomed` places it. */
const handOver = (active: ActiveCompany, leaverId: string, leaverName: string): HandedOver => {
  const lead = active.company.leaderId;
  const now = Date.now();
  const moved: HandedOver = { dropped: 0, rehomed: 0 };
  for (const t of active.tasks.filter((task) => task.assigneeId === leaverId)) {
    const answered = t.betId !== null && answeredOn(t.betId).has(t.id);
    const next = rehomed(t, leaverName, lead, answered, now);
    if (!next) {
      continue;
    }
    // one refused save must not keep the rest on the leaver; the next boot hands that one on
    try {
      recordIn(active.tasks, t.id, next, saveTask);
      if (isHistory(next)) {
        shelveClosed(next);
        moved.dropped += 1;
      } else {
        moved.rehomed += 1;
      }
    } catch (error) {
      report(`hand over task ${t.id}`, error);
    }
  }
  return moved;
};

/** Archive the employee package and hand their open work on, as `handOver` counts it. */
export const archiveEmployee = (
  employeeId: string,
): ({ employee: Employee } & HandedOver) | null => {
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
  return { employee: emp, ...handOver(active, employeeId, emp.name) };
};

// ---- products --------------------------------------------------------------
/** The first product's code is the company's workspace/; it inherits the legacy metrics. */
const firstProduct = (co: Company, vercel: VercelBinding | null): Product => ({
  companyId: co.id,
  createdAt: co.createdAt,
  description: co.mission ?? UNNAMED_PRODUCT_DESCRIPTION,
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
    throw new RefusalError(`no product ${id}`);
  }
  return p;
};

export const listProducts = (): Product[] => [...(current().products ?? [])];

/**
 * Whether `id` is a product of this company, live, retired or one boot could not read: a
 * retired product's paid orders still ship, and an unread one's are kept for when it reads again.
 */
export const madeProduct = (id: string): boolean => {
  const companyId = current().company.id;
  return (
    getProduct(id) !== null ||
    [productsDir(companyId), retiredDir(companyId)].some((dir) => safeReaddir(dir).includes(id))
  );
};

/**
 * Whether `id` was retired: its package sits under retired/ and none under products/. A product
 * boot could not read is missing from the loaded ones but still in products/, so it never reads
 * as retired, and its payment links are never switched off for it.
 */
const retiredIn =
  (companyId: string) =>
  (id: string): boolean =>
    heldIn(retiredDir(companyId))(id) && !heldIn(productsDir(companyId))(id);

export const isRetiredProduct = (id: string): boolean => retiredIn(current().company.id)(id);

/** A product's payment links outlive it: Stripe may make one while its product retires. */
const requireMadeProduct = (id: string): void => {
  if (!madeProduct(id)) {
    throw new RefusalError(`no product ${id}`);
  }
};

const patchProduct = (id: string, patch: Partial<Product>): Product =>
  patchIn(current().products, id, patch, saveProduct);

/** Past the cap a new product has to replace a killed one, whoever starts it: the founder's panel too. */
export const createProduct = (named: ProductDraft): Product => {
  const { company, products: list } = current();
  if (!portfolioHasRoom(list.length)) {
    throw new RefusalError(
      `The company already runs ${MAX_LIVE_PRODUCTS} products; kill_product one before starting another.`,
    );
  }
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

export const noSuchProduct = (productId: string): string =>
  `No product "${productId}" here — the products are ${listProducts()
    .map((p) => p.id)
    .join(", ")}.`;

/**
 * Give a live product the name and description the lead picked for it. Its slug stays, since
 * its workspace, bets, links and orders are all keyed by it.
 */
export const nameProduct = (productId: string, named: ProductDraft): Product => {
  if (getProduct(productId) === null) {
    throw new RefusalError(
      isRetiredProduct(productId)
        ? `${productId} is retired: name a live product.`
        : noSuchProduct(productId),
    );
  }
  const draft = ProductDraftSchema.safeParse(named);
  if (!draft.success) {
    throw new RefusalError(z.prettifyError(draft.error));
  }
  const product = patchProduct(productId, draft.data);
  // every agent's instructions list the products by name
  for (const e of listEmployees()) {
    saveEmployee(e);
  }
  return product;
};

/** One project per product: two on one would each count its visitors, and each deploy replace the other's site. */
export const setProductVercel = (productId: string, vercel: VercelBinding | null): Product => {
  const holder =
    vercel &&
    current().products.find((p) => p.id !== productId && p.vercel?.projectId === vercel.projectId);
  if (vercel && holder) {
    throw new RefusalError(
      `${holder.name} is already bound to the Vercel project ${vercel.projectName}; pick another project, or disconnect ${holder.name} from it first.`,
    );
  }
  return patchProduct(productId, { vercel });
};

/** Real numbers per product, from the pulse. */
export const setProductMetrics = (productId: string, snapshot: MetricsSnapshot): void => {
  const product = getProduct(productId);
  const patch = product ? metricsPatch(product, snapshot) : {};
  if (Object.keys(patch).length > 0) {
    patchProduct(productId, patch);
  }
};

// ---- listings ---------------------------------------------------------------
export const listListings = (): Listing[] => [...current().listings];

/** Listing ids are unique across the company's products (`newListingId`). */
export const getListing = (id: string): Listing | null =>
  current().listings.find((l) => l.id === id) ?? null;

/**
 * A new listing's id: its name's slug, free among every product's listings, skipped ones on disk
 * and those still being made. Held until `releaseListingId`, once the listing is kept or never made.
 */
export const newListingId = (name: string): string => {
  const { company, listings, pendingListings } = current();
  const id = uniqueSlug(name, [...listings.map((l) => l.id), ...pendingListings], (slug) =>
    existsSync(listingFile(company.id, slug)),
  );
  pendingListings.add(id);
  return id;
};

export const releaseListingId = (id: string): void => {
  maybeCurrent()?.pendingListings.delete(id);
};

const saveListing = (listing: Listing): void => {
  atomicWrite(
    listingFile(current().company.id, listing.id),
    `${JSON.stringify(listing, null, 2)}\n`,
  );
};

/**
 * A listing Stripe already sells through its link, so the cache keeps it even when the save
 * throws, and even when its product retired while Stripe made it: money may come through that
 * link either way, until the sweep switches it off.
 */
export const recordListing = (listing: Listing): void => {
  requireMadeProduct(listing.productId);
  const { listings } = current();
  if (listings.some((l) => l.id === listing.id)) {
    throw new Error(`a listing ${listing.id} is already kept`);
  }
  listings.push(listing);
  saveListing(listing);
};

// ---- payment links ----------------------------------------------------------
export const listChargeLinks = (): ChargeLink[] => [...current().links];

export const getChargeLink = (id: string): ChargeLink | null =>
  current().links.find((l) => l.id === id) ?? null;

const saveChargeLink = (link: ChargeLink): void => {
  atomicWrite(linkFile(current().company.id, link.id), `${JSON.stringify(link, null, 2)}\n`);
};

/**
 * A create_payment_link link Stripe already sells through, so the cache keeps it even when the
 * save throws, and even when its product retired while Stripe made it: the sweep must still find
 * it to switch it off.
 */
export const recordChargeLink = (link: ChargeLink): void => {
  requireMadeProduct(link.productId);
  const { links } = current();
  if (links.some((l) => l.id === link.id)) {
    throw new Error(`a payment link ${link.id} is already kept`);
  }
  links.push(link);
  saveChargeLink(link);
};

/** Every payment link the company made, a listing's and create_payment_link's alike. */
export const paymentLinks = (): CompanyLink[] => {
  const { links, listings } = current();
  return [
    ...listings.map(({ livemode, name, paymentLink, productId }) => ({
      id: paymentLink.id,
      livemode,
      name,
      print: true,
      productId,
      state: paymentLink.state,
      url: paymentLink.url,
    })),
    ...links.map(({ id, livemode, name, productId, state, url }) => ({
      id,
      livemode,
      name,
      print: false,
      productId,
      state,
      url,
    })),
  ];
};

/** What retiring a link's product did to it at Stripe. It happened, so the cache keeps it even when the save throws. */
export const setLinkState = (id: string, state: LinkState): void => {
  const { links, listings } = current();
  const listed = listings.findIndex((l) => l.paymentLink.id === id);
  const listing = listings[listed];
  if (listing !== undefined) {
    const next = { ...listing, paymentLink: { ...listing.paymentLink, state } };
    listings[listed] = next;
    saveListing(next);
    return;
  }
  const at = links.findIndex((l) => l.id === id);
  const link = links[at];
  if (link === undefined) {
    throw new Error(`no payment link ${id} is kept`);
  }
  const next = { ...link, state };
  links[at] = next;
  saveChargeLink(next);
};

const UnrecordedLinksSchema = z.array(z.string());

/** Products an older save made whose create_payment_link links IdleBiz never recorded, and has not looked for since. */
export const unrecordedLinkProducts = (): string[] =>
  readJsonFile(unrecordedLinksFile(current().company.id), UnrecordedLinksSchema) ?? [];

export const setUnrecordedLinkProducts = (productIds: readonly string[]): void => {
  atomicWrite(unrecordedLinksFile(current().company.id), JSON.stringify(productIds));
};

// ---- orders -----------------------------------------------------------------
export const listOrders = (): Order[] => [...current().orders];

const saveOrder = (order: Order): void => {
  atomicWrite(orderFile(current().company.id, order.id), `${JSON.stringify(order, null, 2)}\n`);
};

/**
 * A paid checkout, kept before Printful hears of it: a save that throws leaves it unkept, and
 * nothing is sent for it, so a restart always finds what it may already have sent. Only a sale
 * needs its listing: an unreadable order may be one whose listing this save lost.
 */
export const recordOrder = (order: Order): void => {
  const { orders } = current();
  if (order.kind === "sale" && getListing(order.listingId)?.productId !== order.productId) {
    throw new Error(`no listing ${order.listingId} of ${order.productId} is kept`);
  }
  if (orders.some((o) => o.id === order.id)) {
    throw new Error(`order ${order.id} is already kept`);
  }
  saveOrder(order);
  orders.push(order);
};

/**
 * What Printful did with a sale. It happened, so the cache keeps it even when the save throws,
 * and the next write carries it.
 */
export const updateSale = (
  id: string,
  patch: Partial<Pick<Sale, "costCents" | "printfulStatus" | "stage">>,
): Sale => {
  const { orders } = current();
  const idx = orders.findIndex((o) => o.id === id);
  const sale = orders[idx];
  if (sale?.kind !== "sale") {
    throw new Error(`no sale ${id} is kept`);
  }
  const next: Sale = { ...sale, ...patch };
  orders[idx] = next;
  saveOrder(next);
  return next;
};

/**
 * Where reads of Stripe's checkouts go on from, in seconds (Stripe's `created[gt]`): one per key
 * that has read, since a key of another mode or account lists none of this one's sessions, and
 * `floor`, where a key that never read starts.
 */
const OrdersCursorSchema = z.object({
  byKey: z.record(z.string(), z.number().int()),
  floor: z.number().int(),
});
export type OrdersCursor = z.infer<typeof OrdersCursorSchema>;

/** Null before the first read. */
export const ordersCursor = (): OrdersCursor | null =>
  readJsonFile(ordersCursorFile(current().company.id), OrdersCursorSchema);

export const setOrdersCursor = (cursor: OrdersCursor): void => {
  atomicWrite(
    ordersCursorFile(current().company.id),
    JSON.stringify(OrdersCursorSchema.parse(cursor)),
  );
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
/**
 * Open a bet, on a product with room for another. A users bet lands on its own
 * path unless it names one; a named path over the whole site or /b, or one
 * another bet holds, is refused, since it would count visitors this bet did not
 * bring.
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
    throw new RefusalError(noSuchProduct(input.productId));
  }
  if (!productHasRoom(active.bets, product.id)) {
    throw new RefusalError(
      `${product.name} already carries ${MAX_LIVE_BETS_PER_PRODUCT} live bets; wait for a verdict or kill one first.`,
    );
  }
  const refusal =
    input.metric === "users" && input.landingPath !== null
      ? namedPathRefusal(input.landingPath)
      : null;
  if (refusal !== null) {
    throw new RefusalError(refusal);
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
    readAt: null,
    reading: null,
    spentUsd: 0,
    state: { kind: "open" },
    target: input.target,
    title: input.title.trim(),
    windowHours: input.windowHours,
  };
  const rival = active.bets.find((b) => holdsItsPath(b) && claimsCollide(b, bet));
  if (rival?.claim.metric === "users") {
    const holds = isClosed(rival)
      ? "is closed, but its links still send visitors"
      : "already counts visitors";
    throw new RefusalError(
      `"${rival.title}" (${rival.id}) ${holds} under ${rival.claim.landingPath} on ${product.name}; a bet landing there too could not be told apart from it. Leave landingPath out to get a path of its own.`,
    );
  }
  saveBet(bet);
  active.bets.push(bet);
  return bet;
};

/**
 * What the pulse read for a live bet at `at`; a null keeps the last reading
 * through a provider failure. A quiet bet is not rewritten every pulse: the
 * time is stamped when the reading moves, and by the first read after a
 * measuring bet's window closed, which is the one the evaluator waits for.
 */
export const setBetReading = (betId: string, reading: number | null, at: number): void => {
  const bet = getBet(betId);
  if (!bet || isClosed(bet) || reading === null) {
    return;
  }
  const { state, readAt } = bet;
  const firstSinceClose =
    state.kind === "measuring" && at >= state.until && (readAt === null || readAt < state.until);
  if (reading !== bet.reading || firstSinceClose) {
    patchBet(betId, { readAt: at, reading });
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

const dropTask = (taskId: string, reason: string, now: number): void => {
  shelveClosed(
    patchIn(current().tasks, taskId, entering({ kind: "dropped", reason }, now), saveTask),
  );
};

/**
 * Drop the matching work that is waiting into history: no failure, and nothing
 * the founder can revive, since it would only bill a bet or product that takes
 * no more work. A running task finishes its run, and is dropped if that run
 * fails, parks (`failTask`, `parkTask`), asks the founder once its bet has
 * closed (`settleTask`) or never settles before the app restarts
 * (`recoverInterrupted`); on a measuring bet, the founder's answered step is
 * dropped only when its run fails. A dead letter goes too: `claimTask` would refuse every retry of it.
 */
const dropWork = (match: (t: Task) => boolean, reason: string, now: number): void => {
  for (const t of current().tasks.filter(match)) {
    const { kind } = t.state;
    if (kind === "todo" || kind === "queued" || kind === "blocked" || kind === "dead") {
      // one refused save must not keep the rest from dropping; `lockTaskForRun` drops it before it runs
      try {
        dropTask(t.id, reason, now);
      } catch (error) {
        report(`drop task ${t.id}`, error);
      }
    }
  }
};

const BET_MEASURING = "bet is measuring";
const BET_CLOSED = "bet closed";
const BET_KILLED = "bet killed";
const PRODUCT_RETIRED = "product retired";
const ROUTINE_RETIRED = "routine retired";

/** Why the bet takes no more runs, as the work it drops says; null while it is open, or for work on none. */
const stoppedBetReason = (bet: Bet | null): string | null => {
  if (!bet || bet.state.kind === "open") {
    return null;
  }
  return bet.state.kind === "measuring" ? BET_MEASURING : BET_CLOSED;
};

/**
 * Why the task takes no more runs: its bet stopped taking work, or its product retired, and a
 * run would land in the company's folder, billing what takes no more work. Null while it runs on.
 */
const stoppedReason = (
  t: Task,
  bet: Bet | null,
  retired: (productId: string) => boolean,
): string | null =>
  stoppedBetReason(bet) ?? (t.productId !== null && retired(t.productId) ? PRODUCT_RETIRED : null);

const stoppedWorkReason = (t: Task): string | null =>
  stoppedReason(t, t.betId === null ? null : getBet(t.betId), isRetiredProduct);

const retune = (active: ActiveCompany): void => {
  const next = dream(active.policy, active.bets);
  if (next !== active.policy) {
    atomicWrite(policyFile(active.company.id), JSON.stringify(next, null, 2));
    active.policy = next;
  }
};

/**
 * What a measuring bet keeps: work waiting on the founder, or carrying their answer while it
 * can still run, since that step may be the one that moves the number.
 */
const keptWhileMeasuring = (t: Task, answered: ReadonlySet<string>): boolean =>
  t.state.kind === "blocked" || (answered.has(t.id) && t.state.kind !== "dead");

/** The work is shipped: stop spending and let the number answer. */
export const measureBet = (betId: string, now: number): Bet => {
  const bet = getBet(betId);
  if (!bet || bet.state.kind !== "open") {
    throw new RefusalError(`no open bet "${betId}"`);
  }
  const measuring = patchBet(betId, { state: { kind: "measuring", until: windowEnd(bet, now) } });
  const answered = answeredOn(betId);
  dropWork((t) => t.betId === betId && !keptWhileMeasuring(t, answered), BET_MEASURING, now);
  return measuring;
};

const closeAsKilled = (bet: Bet, reason: string, now: number): Bet =>
  patchBet(bet.id, { state: { closedAt: now, kind: "killed", moved: bet.reading, reason } }) ?? bet;

/** Someone gives up on a bet before its window does. */
export const killBet = (betId: string, reason: string, now: number): Bet => {
  const bet = getBet(betId);
  if (!bet || isClosed(bet)) {
    throw new RefusalError(`no live bet "${betId}"`);
  }
  const killed = closeAsKilled(bet, reason, now);
  dropWork((t) => t.betId === betId, BET_KILLED, now);
  retune(current());
  return killed;
};

/**
 * Judge every live bet against the real numbers (see `judge` for `pulsingSince`); returns the ones
 * whose state changed. A verdict the save refuses is reported and leaves that bet as the disk has
 * it, to be judged again on the next tick, without holding back the others'.
 */
export const judgeBets = (now: number, pulsingSince: number | null): Bet[] => {
  const active = current();
  const changed: Bet[] = [];
  for (const bet of active.bets) {
    const state = judge(bet, now, pulsingSince);
    if (state === bet.state) {
      continue;
    }
    try {
      changed.push(patchBet(bet.id, { state }));
    } catch (error) {
      report(`judge bet ${bet.id}`, error);
    }
  }
  const closed = new Set(changed.filter(isClosed).map((b) => b.id));
  if (closed.size > 0) {
    dropWork((t) => t.betId !== null && closed.has(t.betId), BET_CLOSED, now);
    try {
      retune(active);
    } catch (error) {
      report("retune policy", error);
    }
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
export const postTeamMessage = (from: Speaker, text: string): TeamMessage => {
  const active = current();
  const msg: Omit<TeamMessage, "id"> = {
    companyId: active.company.id,
    createdAt: Date.now(),
    from,
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
interface NewTask {
  productId?: string | null;
  betId?: string | null;
  origin: TaskOrigin;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  assigneeId?: string | null;
}

const addTask = (brief: NewTask, state: TaskIn<"todo" | "blocked">["state"]): Task => {
  const { company, tasks: list } = current();
  const t = { ...brief, companyId: company.id };
  const now = Date.now();
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
    createdAt: now,
    description: t.description ?? null,
    id,
    origin: t.origin,
    priority: t.priority ?? "medium",
    productId: t.productId ?? null,
    startedAt: null,
    title: t.title,
    ...entering(state, now),
  };
  saveTask(task);
  list.push(task);
  return task;
};

export const createTask = (brief: NewTask): Task => addTask(brief, { kind: "todo" });

/** An open task by id. Shipped work is history, not something to act on. */
export const getTask = (id: string): Task | null =>
  maybeCurrent()?.tasks.find((task) => task.id === id) ?? null;

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
  if (isHistory(t) && shelveClosed(t)) {
    noteShip(t);
  }
};

const heldBy = (t: Task | null, runId: string): Task | null =>
  t && t.state.kind === "running" && t.state.runId === runId ? t : null;

/**
 * Null on a claim conflict or for anyone off the roster; reviving a dead task resets its retry
 * count. Refused for work whose bet or product stopped taking it, but for the founder's step on
 * a measuring bet: a dead letter there is no such step.
 */
export const claimTask = (taskId: string, employeeId: string): Task | null => {
  const t = getTask(taskId);
  if (!t || !getEmployee(employeeId)) {
    return null;
  }
  const { kind } = t.state;
  const claimable =
    t.origin !== "order" && (kind === "todo" || kind === "blocked" || kind === "dead");
  if (!claimable || (t.assigneeId !== null && t.assigneeId !== employeeId)) {
    return null;
  }
  const stopped = stoppedWorkReason(t);
  if (stopped !== null && (stopped !== BET_MEASURING || kind === "dead")) {
    throw new RefusalError(
      `"${t.title}" won't run again: its ${stopped}, so a run would only bill what takes no more work. The lead can delegate it again under a live bet.`,
    );
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

/**
 * Acquire execution lock: queued -> running, stamp runId. Null if lost race, backing off, waiting
 * on a product boot could not read, or dropped as work its bet or product no longer takes.
 */
export const lockTaskForRun = (taskId: string, runId: string): Task | null => {
  const t = getTask(taskId);
  if (!t || t.state.kind !== "queued") {
    return null;
  }
  if (t.state.nextAttemptAt !== null && t.state.nextAttemptAt > Date.now()) {
    return null;
  }
  // its run would land in shared/, away from the product's code; it runs once the file reads again
  if (t.productId !== null && getProduct(t.productId) === null && !isRetiredProduct(t.productId)) {
    return null;
  }
  // measuring keeps a claimed ask and an answer's continuation, so only a closed bet or a retired product drops here
  const stopped = stoppedWorkReason(t);
  if (stopped !== null && stopped !== BET_MEASURING) {
    dropTask(taskId, stopped, Date.now());
    return null;
  }
  return patchTask(taskId, entering({ kind: "running", runId }, Date.now()));
};

interface Dropped {
  kind: "dropped";
}

/** A run whose bet or product stopped taking work while it ran drops its task rather than leave it waiting; null while both take it. */
const droppedWhenStopped = (t: Task, attempts: number): Dropped | null => {
  const reason = stoppedWorkReason(t);
  if (reason === null) {
    return null;
  }
  shelveClosed(
    recordTask(t.id, { attempts, ...entering({ kind: "dropped", reason }, Date.now()) }),
  );
  return { kind: "dropped" };
};

/**
 * The run settled: the task is done, or waits on the founder. Only the owning run may; null
 * when it no longer holds the lock. An ask on a closed bet or a retired product is dropped: an
 * answer would only bill what takes no more work. One on a measuring bet stays, since that step
 * may be what moves the number.
 */
export const settleTask = (
  taskId: string,
  runId: string,
  state: Settled,
): Settled | Dropped | null => {
  const t = heldBy(getTask(taskId), runId);
  if (!t) {
    return null;
  }
  const stopped = state.kind === "blocked" ? stoppedWorkReason(t) : null;
  const dropped =
    stopped !== null && stopped !== BET_MEASURING ? droppedWhenStopped(t, t.attempts) : null;
  if (dropped) {
    return dropped;
  }
  close(taskId, state);
  return state;
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

/** A run failed: the task takes its next verdict. Only the owning run may; null when it no longer holds the lock. */
export const failTask = (
  taskId: string,
  runId: string,
  error: string,
): FailureVerdict | Dropped | null => {
  const t = heldBy(getTask(taskId), runId);
  if (!t) {
    return null;
  }
  const next = failed(t, error);
  const dropped = droppedWhenStopped(t, next.verdict.attempts);
  if (dropped) {
    return dropped;
  }
  recordTask(taskId, next.task);
  return next.verdict;
};

/**
 * A run parked through no fault of the task — a usage limit, the app quitting: back on
 * the queue from `until`, no attempt burned. Only the owning run may; null when it no
 * longer holds the lock. One carrying the founder's answer on a measuring bet stays too,
 * since that step may be what moves the number.
 */
export const parkTask = (
  taskId: string,
  runId: string,
  until: number,
  lastError: string,
): { kind: "parked" } | Dropped | null => {
  const t = heldBy(getTask(taskId), runId);
  if (!t) {
    return null;
  }
  const carriesAnswer =
    t.betId !== null && stoppedWorkReason(t) === BET_MEASURING && answeredOn(t.betId).has(t.id);
  const dropped = carriesAnswer ? null : droppedWhenStopped(t, t.attempts);
  if (dropped) {
    return dropped;
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

/**
 * Main's card to the founder about an order, in the Inbox beside the team's asks. Null when one
 * with the same title still waits, so a pump that finds the same trouble again raises no second.
 */
export const raiseOrderCard = (title: string, ask: ActionAsk): Task | null => {
  const waiting = current().tasks.some(
    (t) => t.origin === "order" && t.title === title && t.state.kind === "blocked",
  );
  return waiting
    ? null
    : addTask(
        { description: null, origin: "order", priority: "high", title },
        { ask, kind: "blocked", summary: null },
      );
};

/** The founder settled an order card: history, which no run carries on. Null for any other task. */
export const closeOrderCard = (taskId: string): Task | null => {
  const t = getTask(taskId);
  if (t?.origin !== "order" || t.state.kind !== "blocked") {
    return null;
  }
  const closed = recordTask(taskId, entering({ by: null, kind: "superseded" }, Date.now()));
  shelveClosed(closed);
  return closed;
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
 * Retire a product: its live bets die with it, its waiting work is dropped,
 * and its package moves to retired/ whole, with its code beside PRODUCT.md even
 * when that lived outside the package, as the first product's does. The last
 * product cannot go — a company with none would be handed a fresh first product
 * at the next boot. Nor can one a teammate's run is working in: the move would
 * pull the tree out from under it, and a retry would land as company-level
 * work. `by` is the employee retiring it, whose own run is exempt; null is the
 * founder. Its listings, links and orders stay: main switches its links off at Stripe
 * (`switchOffRetiredLinks`), and every paid order still ships. Returns the bets it took down.
 */
export const killProduct = (productId: string, reason: string, by: string | null): Bet[] => {
  const product = requireProduct(productId);
  const active = current();
  if (active.products.length === 1) {
    throw new RefusalError(
      `${product.name} is the only product — start its successor with create_product first.`,
    );
  }
  const busy = active.tasks.find(
    (t) => t.productId === productId && t.state.kind === "running" && t.assigneeId !== by,
  );
  if (busy) {
    const runner = busy.assigneeId === null ? null : getEmployee(busy.assigneeId);
    throw new RefusalError(
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
  dropWork((t) => t.productId === productId, PRODUCT_RETIRED, now);
  active.products.splice(active.products.indexOf(product), 1);
  for (const e of active.employees) {
    saveEmployee(e, { onlyIfChanged: true });
  }
  return killed;
};

// ---- founding and boot -------------------------------------------------------
/** Publish a complete company with one directory rename; boot ignores staging directories. */
/** The root's entries a company may be in: dot folders are main's own, and the tool cache is every run's to write. */
const saveEntries = (): string[] =>
  safeReaddir(ROOT_DIR).filter(
    (entry) => !entry.startsWith(".") && companyDir(entry) !== TOOL_CACHE_DIR,
  );

export const foundCompany = (input: {
  name: string;
  mission: string | null;
  businessType: BusinessTypeId;
  founderName: string;
  founderSpriteSeed: string;
  budget: Budget;
  hires: readonly FoundingHire[];
}): Company => {
  if (c().active) {
    throw new RefusalError("a company is already active");
  }
  if (saveEntries().some((entry) => existsSync(companyFile(entry)))) {
    throw new RefusalError("an existing company save must be loaded or repaired before founding");
  }
  const id = uniqueSlug(
    input.name,
    [],
    (s) => companyDir(s) === TOOL_CACHE_DIR || existsSync(companyDir(s)),
  );
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
    throw new RefusalError(`the office is at its ${co.maxAgents}-seat cap`);
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
  for (const entry of saveEntries()) {
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

/**
 * A run the last launch never saw settle: dropped with a bet or product that stopped taking
 * work, but for one carrying the founder's answer on a measuring bet, else counted as failed.
 */
const recoverInterrupted = (task: Task, active: ActiveCompany, now: number): Task => {
  const bet = active.bets.find((b) => b.id === task.betId) ?? null;
  const stopped = stoppedReason(task, bet, retiredIn(active.company.id));
  const carriesAnswer =
    bet !== null && stopped === BET_MEASURING && answeredIn(shippedOf(active), bet.id).has(task.id);
  if (stopped !== null && !carriesAnswer) {
    return { ...task, ...entering({ kind: "dropped", reason: stopped }, now) };
  }
  return task.assigneeId
    ? failed(task, "Interrupted by app restart").task
    : { ...task, state: { kind: "todo" } };
};

/** Shelve the history among `tasks`, returning the open work. */
const shelveLoadedHistory = (active: ActiveCompany, tasks: Task[]): Task[] => {
  for (const task of tasks.filter(isHistory)) {
    try {
      shelve(task);
      active.shipped?.push(task);
    } catch (error) {
      skip("task", taskFile(active.company.id, task.id), error);
    }
  }
  return tasks.filter((task) => !isHistory(task));
};

/**
 * Recover the runs the last launch never saw settle. Runs once an older save's answers are named
 * (`adoptOlderAnswers`): recovery keeps a measuring bet's answered step only once it is.
 */
const recoverInterruptedRuns = (active: ActiveCompany): void => {
  const now = Date.now();
  for (const [i, task] of active.tasks.entries()) {
    if (task.state.kind === "running") {
      const recovered = recoverInterrupted(task, active, now);
      active.tasks[i] = recovered;
      saveTask(recovered);
    }
  }
  active.tasks = shelveLoadedHistory(active, active.tasks);
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
  active.tasks = shelveLoadedHistory(active, tasks);
  active.products = loadPackages(
    "product",
    productsDir(company.id),
    (slug) => productFile(company.id, slug),
    (doc) => docToProduct(doc, company.id),
  ).toSorted(byAge);
  active.listings = loadRecords("listing", listingsDir(company.id), ListingSchema);
  active.links = loadRecords("link", linksDir(company.id), ChargeLinkSchema);
  active.orders = loadRecords("order", ordersDir(company.id), OrderSchema);
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

/** Whether the company lost its last product; one boot could not read is still its own. */
const lacksProduct = (active: ActiveCompany): boolean => {
  const { id } = active.company;
  return (
    active.products.length === 0 && !holdsPackage(productsDir(id), (slug) => productFile(id, slug))
  );
};

/** Whether the save named no lead on the roster and one was elected; unsaved. */
const electMissingLead = (active: ActiveCompany): boolean => {
  const { company, employees } = active;
  if (employees.length === 0 || employees.some((e) => e.id === company.leaderId)) {
    return false;
  }
  active.company = { ...company, leaderId: leadOf(employees) };
  return true;
};

/** A company always has a product to work on; one that lost its last is given its mission back as one. */
const ensureFirstProduct = (active: ActiveCompany, vercel: VercelBinding | null): void => {
  if (lacksProduct(active)) {
    const first = firstProduct(active.company, vercel);
    mkdirSync(first.workspaceDir, { recursive: true });
    active.products.push(first);
    saveProduct(first);
  }
};

/**
 * A save from before products ran every task in workspace/, now its first product's code, and
 * the company's own folder is shared/: its open work, left on no product, would run there.
 */
const adoptProductlessWork = (active: ActiveCompany): void => {
  const [first] = active.products;
  if (first === undefined) {
    return;
  }
  active.tasks = active.tasks.map((t) => {
    if (t.productId !== null) {
      return t;
    }
    const adopted: Task = { ...t, productId: first.id };
    saveTask(adopted);
    return adopted;
  });
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

const UNMARKED_REVENUE =
  "adopted from a build whose payment links carried no mark of this bet, so nothing could measure it";
const UNMARKED_USERS =
  "adopted from a build that counted every visitor to the product as this bet's, so nothing could measure it";

/**
 * Format 0 judged a bet on its product's whole number: a revenue bet on all its money, whose links
 * tagged only the product, and a users bet on every visitor, with no path of its own ("/" as the
 * codec reads it; namedPathRefusal refuses it to every bet since). Why such a bet cannot be
 * measured, or null for a bet that carries its own mark.
 */
const unmarkedReason = (claim: BetClaim): string | null => {
  if (claim.metric === "revenue") {
    return UNMARKED_REVENUE;
  }
  return claim.landingPath === "/" ? UNMARKED_USERS : null;
};

/**
 * A format 0 bet still live would read none of its own money, or visitors it did not bring: it
 * closes unmeasured, a verdict neither the replay nor the allocator counts. Its waiting work goes
 * with it in adoptStoppedBetWork.
 */
const adoptUnmarkedBets = (active: ActiveCompany): void => {
  const now = Date.now();
  for (const bet of active.bets.filter((b) => !isClosed(b))) {
    const reason = unmarkedReason(bet.claim);
    if (reason !== null) {
      const state: BetState = { closedAt: now, kind: "killed", moved: null, reason };
      recordIn(active.bets, bet.id, { state }, saveBet);
    }
  }
};

/**
 * The continuation an older build made for an answered ask without naming it: the first made once
 * the ask closed (those builds closed it first) on its bet and product under its title, that no
 * other answer names.
 */
const continuationOf = (
  ask: Task,
  work: readonly Task[],
  named: ReadonlySet<string>,
): Task | null =>
  work
    .filter(
      (t) =>
        t.betId === ask.betId &&
        t.productId === ask.productId &&
        t.title === continuationTitle(ask.title) &&
        t.createdAt >= (ask.completedAt ?? ask.createdAt) &&
        !named.has(t.id),
    )
    .toSorted(byAge)[0] ?? null;

/**
 * Format 7 and older shelved an answer adopted from format 1 naming no continuation, so measuring
 * its bet dropped the one carrying the founder's answer: name it, where it is still found.
 */
const adoptAnswerLinks = (active: ActiveCompany): void => {
  const companyId = active.company.id;
  const shipped = listShippedTasks();
  const work = [...active.tasks, ...shipped];
  const named = new Set(
    shipped.flatMap((t) =>
      t.state.kind === "superseded" && t.state.by !== null ? [t.state.by] : [],
    ),
  );
  const linked = new Map<string, Task>();
  for (const ask of shipped.toSorted(byAge)) {
    const next =
      ask.state.kind === "superseded" && ask.state.by === null
        ? continuationOf(ask, work, named)
        : null;
    if (next !== null) {
      named.add(next.id);
      const answered: Task = { ...ask, state: { by: next.id, kind: "superseded" } };
      atomicWrite(shippedTaskFile(companyId, ask.id), serializeDoc(taskToDoc(answered)));
      linked.set(ask.id, answered);
    }
  }
  active.shipped = shipped.map((t) => linked.get(t.id) ?? t);
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
 * Format 2 and older retired the first product without its code, which stayed in workspace/
 * as the company's working directory. The retired package's kept path says whose it was: the
 * one outside a package of its own. Runs after adoptProductWorkspaces: until then every live
 * product reads as the one coding in workspace/.
 */
const adoptRetiredFirstWorkspace = (active: ActiveCompany): void => {
  const { id } = active.company;
  const code = companyWorkspace(id);
  if (!existsSync(code) || active.products.some((p) => p.workspaceDir === code)) {
    return;
  }
  const owner = safeReaddir(retiredDir(id)).find((slug) => {
    const legacy = optStr(
      parseDoc(readTextIfPresent(path.join(retiredDir(id), slug, "PRODUCT.md")) ?? "").metadata,
      "workspaceDir",
    );
    return legacy !== null && !legacy.endsWith(path.join("products", slug, "workspace"));
  });
  const archive = owner === undefined ? null : path.join(retiredDir(id), owner, "workspace");
  if (archive !== null && !existsSync(archive)) {
    moveDir(code, archive);
  }
};

/** The reasons format 5 and older dead-lettered the work the steering loop dropped with. */
const DROP_REASONS: ReadonlySet<string> = new Set([
  BET_MEASURING,
  BET_CLOSED,
  BET_KILLED,
  PRODUCT_RETIRED,
]);

/**
 * Format 5 and older dead-lettered the work a bet, a retired product or a release dropped,
 * beside real failures, so the Inbox offered it back. The reason each kept tells them apart.
 */
const adoptDroppedWork = (active: ActiveCompany): void => {
  for (const t of active.tasks.filter(taskIn("dead"))) {
    const reason = t.state.lastError;
    if (DROP_REASONS.has(reason) || reason.endsWith(RELEASED)) {
      shelveClosed(recordIn(active.tasks, t.id, { state: { kind: "dropped", reason } }, saveTask));
    }
  }
};

/**
 * Format 5 and older could leave a measured or closed bet's waiting work queued, to run and
 * bill it: drop it as the bet's change does. A measuring bet keeps what waits on the founder,
 * or carries their answer.
 */
const adoptStoppedBetWork = (active: ActiveCompany): void => {
  const now = Date.now();
  for (const bet of active.bets) {
    const reason = stoppedBetReason(bet);
    if (reason !== null) {
      const answered = answeredOn(bet.id);
      dropWork(
        (t) => t.betId === bet.id && (reason === BET_CLOSED || !keptWhileMeasuring(t, answered)),
        reason,
        now,
      );
    }
  }
};

/**
 * Format 9 and older kept a dead letter when its bet stopped or its product retired, and the
 * Inbox offered it back for good, though `claimTask` refuses every retry of it.
 */
const adoptStrandedDeadLetters = (active: ActiveCompany): void => {
  const now = Date.now();
  for (const t of active.tasks.filter(taskIn("dead"))) {
    const stopped = stoppedWorkReason(t);
    if (stopped !== null) {
      dropTask(t.id, stopped, now);
    }
  }
};

/** What the retired push tool asked the founder to sign: `push <branch> (<sha>) of <product> to <url>`. */
const PUSH_SIGN_OFF = /^push \S+ \(/u;

/** A continuation's brief quoting a push sign-off the founder approved, which it would go on to run. */
const APPROVED_PUSH =
  /^> permission to run `(?<command>push \S+ \(.+)`\n\nThe founder answered:\n> Approved\./mu;

/** The push sign-off `t` waits on or would go on to run, if any. */
const pushSignOffOf = (t: Task): string | null => {
  const { state } = t;
  if (state.kind === "blocked") {
    return state.ask.type === "approval" && PUSH_SIGN_OFF.test(state.ask.command)
      ? state.ask.command
      : null;
  }
  if (state.kind === "todo" || state.kind === "queued" || state.kind === "running") {
    return APPROVED_PUSH.exec(t.description ?? "")?.groups?.command ?? null;
  }
  return null;
};

/**
 * Format 6 and older could hold a task on a sign-off for the push tool, which is gone, or queue
 * the continuation of one the founder approved: either would send the agent to a route that no
 * longer answers. Each becomes a question the founder can answer once they have pushed by hand,
 * a granted one is taken back, and the repositories the tool staged pushes in are removed. The
 * question says to push from a fresh clone: git run inside the workspace obeys the config and
 * hooks the team writes there, as the founder.
 */
const adoptRetiredPush = (active: ActiveCompany): void => {
  for (const t of active.tasks) {
    const command = pushSignOffOf(t);
    if (command !== null) {
      const workspace =
        active.products.find((p) => p.id === t.productId)?.workspaceDir ?? "the workspace";
      const question = `The team no longer pushes code, so this waits on you instead: ${command}. To push it, clone it fresh with \`git clone --no-local ${workspace} <new folder>\` and push from that clone, never with git inside the workspace: it holds what the team wrote, and git there could run it as you. Then answer to let the task go on.`;
      const summary = t.state.kind === "blocked" ? t.state.summary : null;
      recordIn(
        active.tasks,
        t.id,
        { state: { ask: { question, type: "question" }, kind: "blocked", summary } },
        saveTask,
      );
    }
  }
  const kept = active.grants.filter((g) => !PUSH_SIGN_OFF.test(g.key));
  if (kept.length < active.grants.length) {
    writeGrants(kept);
  }
  rmSync(path.join(ROOT_DIR, ".push"), { force: true, recursive: true });
};

/**
 * Format 0 seeded routines whose work belongs to bets now. Their waiting runs go too, a run the
 * quit cut off included, which boot has queued again by now: each would bill the company outside
 * every bet, as the founder's work, since the save kept no origin.
 */
const dropRetiredRoutines = (active: ActiveCompany): void => {
  const retired = active.routines.filter((r) => RETIRED_ROUTINES.includes(r.id));
  for (const routine of retired) {
    active.routines.splice(active.routines.indexOf(routine), 1);
    rmSync(path.dirname(routineFile(routine.companyId, routine.id)), {
      force: true,
      recursive: true,
    });
  }
  const names = new Set(retired.map((r) => r.name));
  dropWork(
    (t) => t.betId === null && names.has(t.title) && isRoutineBrief(t.description),
    ROUTINE_RETIRED,
    Date.now(),
  );
};

/**
 * Format 6 and older seeded routines whose words sent a store audit to draft a promotion, a
 * bet's job, and a VC to write investment memos, which it never sells. One the founder left as
 * seeded takes its preset's words now.
 */
const adoptRewordedRoutines = (active: ActiveCompany): void => {
  for (const r of active.routines) {
    const instruction = REWORDED_ROUTINES.get(r.instruction);
    if (instruction !== undefined) {
      recordIn(active.routines, r.id, { instruction }, saveRoutine);
    }
  }
};

/**
 * Format 6 and older read no checkouts, and a first read starts at founding: it would take every
 * sale an older company ever made on a link as new, each posted to the room. Its reads start now.
 */
const adoptOrdersCursor = (): void => {
  setOrdersCursor({ byKey: {}, floor: Math.floor(Date.now() / 1000) });
};

/**
 * Format 6 and older kept no record of the links create_payment_link made, so retiring a product
 * could not switch them off: each product it made is looked for at Stripe once it retires, those
 * it already retired on the first pulse.
 */
const adoptUnrecordedLinks = (active: ActiveCompany): void => {
  const made = [...active.products.map((p) => p.id), ...safeReaddir(retiredDir(active.company.id))];
  if (made.length > 0) {
    setUnrecordedLinkProducts(made);
  }
};

/** An older save's lead proposal, by its fixed title behind any "Continue: " an answer added. */
const PROPOSAL_TITLE = /^(?:Continue: )*Open the next bet for /u;

/**
 * Format 3 and older kept no origin, so the codec reads the lead's bet-less proposal as the
 * founder's: it would hold no new bets while it waits, and its answer could delegate work no
 * bet funds. Its title tells it apart.
 */
const adoptProposalOrigins = (active: ActiveCompany): void => {
  for (const t of active.tasks) {
    if (t.betId === null && t.origin !== "propose" && PROPOSAL_TITLE.test(t.title)) {
      recordIn(active.tasks, t.id, { origin: "propose" }, saveTask);
    }
  }
};

/**
 * A release cut short (a quit, a refused save) or an older build's left the leaver's asks and
 * dead letters on their id, which no claim reaches: an answer queued a continuation nobody
 * runs. Whoever an open task names off the roster, with no package under agents/ that boot
 * merely could not read, is released now, known only by that id, to the lead elected before.
 */
const releaseOrphanedTasks = (active: ActiveCompany): void => {
  const roster = new Set(active.employees.map((e) => e.id));
  const unread = heldIn(agentsDir(active.company.id));
  const leavers = new Set(
    active.tasks.flatMap((t) =>
      t.assigneeId === null || roster.has(t.assigneeId) || unread(t.assigneeId)
        ? []
        : [t.assigneeId],
    ),
  );
  for (const leaver of leavers) {
    handOver(active, leaver, leaver);
  }
};

/** The reasons create_payment_link, sell_print and the checkout grant check gave a Stripe key ask. */
const KEY_ASK_REASON = /^(?:to sell .+ through a payment link$|Stripe won't let IdleBiz's key )/u;

/**
 * Format 10 and older filed an ask for a Stripe key to charge with as one for Stripe Connect,
 * which only reads revenue: completing Connect resumed it into a run that found no key.
 */
const adoptStripeKeyAsks = (active: ActiveCompany): void => {
  for (const t of active.tasks) {
    const { state } = t;
    if (
      state.kind === "blocked" &&
      state.ask.type === "integration" &&
      state.ask.integration === "stripe" &&
      KEY_ASK_REASON.test(state.ask.reason)
    ) {
      const keyAsk: TaskState = { ...state, ask: { ...state.ask, integration: "stripe-key" } };
      recordIn(active.tasks, t.id, { state: keyAsk }, saveTask);
    }
  }
};

/** The product each Vercel ask a tool raised names, as its reason words it. */
const VERCEL_ASK_PRODUCT = [
  /^to deploy (?<name>.+)$/u,
  /^to bind (?<name>.+) to its Vercel project: one named ".*" already exists$/u,
  /^to set \S+ on (?<name>.+)$/u,
  /^to check where (?<name>.+) (?:serves its print files|sends buyers who paid)$/u,
  /^Vercel turned IdleBiz's token away while checking (?<name>.+)'s domains$/u,
];

/**
 * Format 10 and older could keep a Vercel ask without its product, which the codec reads as
 * the task's own, but a run could ask about another product it named: its card opened the
 * wrong product's panel, and binding the product it named never resumed it. The one its
 * reason names, where exactly one product has that name, is the one it is about.
 */
const adoptVercelAskProducts = (active: ActiveCompany): void => {
  for (const t of active.tasks) {
    const { state } = t;
    if (
      state.kind !== "blocked" ||
      state.ask.type !== "integration" ||
      state.ask.integration !== "vercel" ||
      optStr(
        parseDoc(readTextIfPresent(taskFile(t.companyId, t.id)) ?? "").metadata,
        "askProduct",
      ) !== null
    ) {
      continue;
    }
    const { reason } = state.ask;
    const name = VERCEL_ASK_PRODUCT.map((pattern) => pattern.exec(reason)?.groups?.name).find(
      (named) => named !== undefined,
    );
    const [named, ...namesakes] = active.products.filter((p) => p.name === name);
    if (named !== undefined && namesakes.length === 0 && named.id !== state.ask.productId) {
      const ask = { ...state.ask, productId: named.id };
      recordIn(active.tasks, t.id, { state: { ...state, ask } }, saveTask);
    }
  }
};

/**
 * Format 10 and older let two products bind one Vercel project: each counted the other's visitors
 * as its users, and each deploy replaced the other's site. The oldest keeps it. Only the founder
 * can give the others a project of their own, so the room says which lost theirs; it is read
 * afresh once the office opens, so the line needs no event.
 */
const adoptSharedVercelProjects = (active: ActiveCompany): void => {
  const holders = new Map<string, Product>();
  for (const p of active.products.toSorted(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )) {
    const holder = p.vercel && holders.get(p.vercel.projectId);
    if (p.vercel && holder) {
      recordIn(active.products, p.id, { users: null, vercel: null }, saveProduct);
      postTeamMessage(
        { kind: "office" },
        `${p.name} was bound to the Vercel project ${p.vercel.projectName}, which ${holder.name} holds too, so each counted the other's visitors and each deploy replaced the other's site. ${p.name} is unbound now: bind it to a project of its own with its ▲ Vercel button in Products, or its next deploy asks you to sign for a new project named after it.`,
      );
    } else if (p.vercel) {
      holders.set(p.vercel.projectId, p);
    }
  }
};

/**
 * Format 4 and older wrote each room line's speaker as an employee id or null:
 * rewrite the whole room in the shape that tells founder, office and employee
 * apart. A line neither shape reads was already skipped by every reader.
 */
const adoptSpeakers = (companyId: string): void => {
  const file = chatFile(companyId);
  const text = readTextIfPresent(file);
  if (text === null) {
    return;
  }
  const rows = text.split("\n").flatMap((line) => {
    try {
      const row = AdoptedTeamMessageSchema.safeParse(parseJson(line));
      return row.success ? [row.data] : [];
    } catch {
      return [];
    }
  });
  atomicWrite(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
};

/**
 * The first part of `adoptOlderSave`: name the answers an older save shelved, before boot
 * recovers the runs the last launch cut off, since recovery reads them.
 */
const adoptOlderAnswers = (active: ActiveCompany, from: number): void => {
  if (from < 2) {
    adoptAnsweredAsks(active);
  }
  // before any step that reads answeredOn: a release or a measuring bet keeps an answer only once it is named
  if (from < 8) {
    adoptAnswerLinks(active);
  }
};

/**
 * Bring a save written in format `from` up to this one, once: saveCompany
 * then stamps it, and none of this runs for it again. A step written for
 * format N runs only for saves stamped below it. Everything that reads an
 * old shape of the company's files belongs here or in `adoptOlderAnswers`,
 * so it has a date it can be deleted on; tolerant field reads inside the
 * codecs are not migrations. Runs once interrupted runs are recovered.
 */
const adoptOlderSave = (active: ActiveCompany, from: number): void => {
  const { id } = active.company;
  if (from < 1) {
    adoptLegacyTeam(active.company);
    if (lacksProduct(active)) {
      const vercel = legacyVercel(id);
      ensureFirstProduct(active, vercel);
      adoptProductlessWork(active);
      if (vercel !== null) {
        writeMetricsConfig(id, { vercel: undefined });
      }
    }
    dropRetiredRoutines(active);
    adoptUnmarkedBets(active);
  }
  if (from < 3) {
    adoptProductWorkspaces(active);
    adoptRetiredFirstWorkspace(active);
  }
  if (from < 4) {
    adoptProposalOrigins(active);
  }
  if (from < 5) {
    adoptSpeakers(active.company.id);
    loadRecentChat(active);
  }
  if (from < 6) {
    adoptDroppedWork(active);
    adoptStoppedBetWork(active);
  }
  if (from < 7) {
    adoptRetiredPush(active);
    adoptRewordedRoutines(active);
    adoptOrdersCursor();
    adoptUnrecordedLinks(active);
  }
  if (from < 9) {
    // Format 8 and older took Stripe's customer count for users while no Vercel read answered;
    // the next pulse reads visitors again wherever a product is bound.
    active.company = { ...active.company, users: null };
  }
  if (from < 10) {
    adoptStrandedDeadLetters(active);
  }
  if (from < 11) {
    adoptStripeKeyAsks(active);
    adoptSharedVercelProjects(active);
    adoptVercelAskProducts(active);
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
    // three different jobs, in this order: adopt an older format (its answers before the runs a
    // quit cut off are recovered), repair what must always hold, then serve
    if (format < SAVE_FORMAT) {
      adoptOlderAnswers(active, format);
    }
    recoverInterruptedRuns(active);
    if (format < SAVE_FORMAT) {
      adoptOlderSave(active, format);
    }
    ensureFirstProduct(active, null);
    dropEndedGrants(active);
    mkdirSync(company.workspaceDir, { recursive: true });
    if (electMissingLead(active)) {
      saveCompany(active.company);
    }
    releaseOrphanedTasks(active);
    if (!holdsPackage(routinesDir(company.id), (slug) => routineFile(company.id, slug))) {
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
