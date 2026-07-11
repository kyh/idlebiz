import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  ROOT_DIR,
  ensureAppDirs,
  companyDir,
  companyFile,
  companyWorkspace,
  activityFile,
  agentsDir,
  employeeAgentDir,
  employeeFile,
  employeeMemoryDir,
  employeeSessionDir,
  tasksDir,
  taskFile,
  routinesDir,
  routineFile,
  teamsDir,
  teamFile,
  teamChatFile,
} from "@/main/paths";
import {
  parseDoc,
  serializeDoc,
  slugify,
  reqStr,
  optStr,
  reqNum,
  optNum,
  optBool,
  strArray,
  type FrontmatterDoc,
  type Scalar,
} from "@/main/store/frontmatter";
import {
  BUSINESS_TYPES,
  MAX_TASK_ATTEMPTS,
  businessTypeById,
  isAgentRunner,
} from "@/shared/domain";
import type {
  ActivityEvent,
  AgentRunner,
  Budget,
  BusinessTypeId,
  Company,
  Employee,
  Routine,
  Task,
  TaskPriority,
  TaskStatus,
  Team,
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
  teams: Map<string, Team[]>; // companyId -> teams
  teamChat: Map<string, TeamMessage[]>; // teamId -> recent room messages (ring)
  activity: ActivityEvent[]; // ring buffer across companies (UI stream)
  nextActivityId: number;
  nextTeamMessageId: number;
}

let cache: Cache | null = null;

function routineToDoc(r: Routine): FrontmatterDoc {
  const metadata: Record<string, Scalar> = { intervalHours: r.intervalHours };
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
    lastRunAt: doc.metadata.lastRunAt === undefined ? null : optNum(doc.metadata, "lastRunAt", 0),
  };
}

function saveRoutine(r: Routine): void {
  atomicWrite(routineFile(r.companyId, r.id), serializeDoc(routineToDoc(r)));
}

function teamToDoc(t: Team): FrontmatterDoc {
  const metadata: Record<string, Scalar> = {
    memberIds: JSON.stringify(t.memberIds),
    createdAt: t.createdAt,
  };
  if (t.leaderId !== null) metadata.leaderId = t.leaderId;
  return {
    fields: { schema: "agentcompanies/v1", kind: "team", slug: t.id, name: t.name },
    metadata,
    body: `${t.purpose}\n`,
  };
}

function docToTeam(doc: FrontmatterDoc, companyId: string): Team {
  return {
    id: reqStr(doc.fields, "slug"),
    companyId,
    name: reqStr(doc.fields, "name"),
    purpose: doc.body.trim(),
    leaderId: optStr(doc.metadata, "leaderId"),
    memberIds: strArray(doc.metadata, "memberIds"),
    createdAt: optNum(doc.metadata, "createdAt", Date.now()),
  };
}

function saveTeam(t: Team): void {
  atomicWrite(teamFile(t.companyId, t.id), serializeDoc(teamToDoc(t)));
}

function c(): Cache {
  if (!cache) throw new Error("store not initialized");
  return cache;
}

// Reset gate: once suspended, no disk write may land — an in-flight run settling
// after ~/.idlebiz is deleted would otherwise resurrect files mid-teardown.
let writesSuspended = false;
export function suspendWrites(): void {
  writesSuspended = true;
}

function atomicWrite(path: string, content: string): void {
  if (writesSuspended) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// ---- serialization ----------------------------------------------------------
function companyToDoc(co: Company): FrontmatterDoc {
  return {
    fields: {
      schema: "agentcompanies/v1",
      kind: "company",
      slug: co.id,
      name: co.name,
      description: co.mission,
    },
    metadata: {
      founderName: co.founderName,
      founderSpriteSeed: co.founderSpriteSeed,
      businessType: co.businessType,
      autopilot: co.autopilot,
      cash: co.cash,
      ships: co.ships,
      users: co.users,
      budgetMode: co.budget.mode,
      ...(co.budget.mode === "capped" ? { budgetCapUsd: co.budget.capUsd } : {}),
      spentUsd: co.spentUsd,
      onboarded: co.onboarded,
      createdAt: co.createdAt,
    },
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
    founderSpriteSeed: optStr(m, "founderSpriteSeed") ?? "founder-player-001",
    autopilot: optBool(m, "autopilot", true),
    cash: optNum(m, "cash", 0),
    ships: optNum(m, "ships", 0),
    users: optNum(m, "users", 0),
    budget: parseBudget(m),
    spentUsd: Math.max(0, optNum(m, "spentUsd", 0)),
    onboarded: optBool(m, "onboarded", false),
    createdAt: reqNum(m, "createdAt"),
  };
}

/** Legacy saves carry "provider/model" strings from the pi era — not a valid override. */
function parseModelOverride(v: string | null): string | null {
  if (!v || v.includes("/")) return null;
  return v;
}

function parseRunner(v: string | null): AgentRunner {
  return v && isAgentRunner(v) ? v : "codex";
}

/** The body of AGENTS.md doubles as the agent's actual instructions (injected into every run). */
function employeeBody(e: Employee, co: Company): string {
  return `# ${e.name} — ${e.title || e.role}

You are ${e.name}, the ${e.title || e.role} at "${co.name}", a startup.
${e.persona}

## Company mission
${co.mission}

## How you work
- You share a real company workspace at: ${co.workspaceDir}
- Files you create, edit, and run here are REAL. Produce concrete artifacts.
- When given a task, do it concretely and completely: write real code/docs, run commands, verify your work.
- Finish with a short summary of exactly what you did and which files/artifacts you produced.
- You have a private memory folder at ${employeeMemoryDir(co.id, e.id)} — keep notes/decisions there so future-you remembers.

## Company tools (the IdleBiz API)
Every run gives you the env vars \`IDLEBIZ_API_URL\` and \`IDLEBIZ_RUN_TOKEN\`. Call company tools with curl; always send the Authorization header. Quote JSON carefully (single-quote the payload).
- **ask_boss** — you are blocked or need a decision only the founder can make. Use sparingly; prefer making reasonable choices yourself. Note the answer arrives later — continue with whatever you can still do.
  \`curl -s -X POST "$IDLEBIZ_API_URL/v1/ask-boss" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN" -H "content-type: application/json" -d '{"question":"..."}'\`
- **message_team** — post a one-line update, decision, ask, or handoff to the team room so teammates see it live.
  \`curl -s -X POST "$IDLEBIZ_API_URL/v1/message-team" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN" -H "content-type: application/json" -d '{"text":"..."}'\`
- **read_team_chat** — catch up on the room before you act, so you build on teammates' work instead of duplicating it.
  \`curl -s "$IDLEBIZ_API_URL/v1/team-chat" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN"\`
- **delegate** — hand work to a teammate of a given role (they pick it up autonomously and report back in the room). Call once to chain a handoff, or several times to fan work out in parallel.
  \`curl -s -X POST "$IDLEBIZ_API_URL/v1/delegate" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN" -H "content-type: application/json" -d '{"role":"engineer","title":"...","description":"..."}'\`

## Working with your team
- You operate autonomously to grow the business — you don't wait to be told what to do.
- You belong to a team with a designated lead. Catch up with read_team_chat before you start.
- Post short progress updates to the room with message_team so teammates can see them live.
- When work is better owned by another role, hand it off with delegate. If you lead the team, coordinating and delegating is your main job.

## Make the business REAL
- The goal is a real product with real users, not documents about one. Bias toward a runnable, shippable thing.
- Keep \`PRODUCT.md\` at the workspace root up to date — it is how the founder finds the product. Format:
  \`entry: <relative path or URL to open the product, e.g. dist/index.html or https://...>\`
  \`status: <one line on the current state>\`
  Update \`entry\` whenever the canonical way to open the product changes (and after any deploy, set it to the public URL).
- Publishing: from the product's folder you can run \`vg deploy\` to publish it to the web and get a public URL. ALWAYS ask the founder first via \`ask_boss\` before publishing or re-publishing.
- Marketing & outreach: write real copy, launch posts, outreach drafts. You can research and test in a real browser with the \`agent-browser\` CLI (\`agent-browser open <url>\`, \`snapshot\`, \`click\`, \`type\`, \`screenshot\`) — use \`--session yourname\` to keep your own browser session. To POST anywhere public: draft the exact content first, get founder approval via \`ask_boss\` (include the draft in your question), and only then publish it.
- Secrets: the founder may configure API keys (e.g. STRIPE_SECRET_KEY) — they're available to you as environment variables. Never print or commit secret values.
- Real metrics: if the founder wires up \`metrics.json\`, the business dashboard reads REAL users/revenue — your work moves real numbers. You can also propose analytics for the product (e.g. a /metrics endpoint returning {"users":n,"revenue":n}) and ask the founder to point metrics.json at it.
- Permission rule: anything outward-facing — publishing, posting publicly, creating accounts, spending money — needs founder sign-off first via \`ask_boss\`. Internal work in the workspace never needs permission.
- After shipping something findable (a URL, a file), say exactly where it lives in your summary.
`;
}

function employeeToDoc(e: Employee, co: Company): FrontmatterDoc {
  const metadata: Record<string, Scalar> = {
    role: e.role,
    title: e.title,
    persona: e.persona,
    runner: e.runner,
    spriteSeed: e.spriteSeed,
    deskIndex: e.deskIndex,
    status: e.status,
    createdAt: e.createdAt,
  };
  if (e.model !== null) metadata.model = e.model;
  if (e.sessionId !== null) metadata.sessionId = e.sessionId;
  if (e.teamId !== null) metadata.teamId = e.teamId;
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
    model: parseModelOverride(optStr(m, "model")),
    sessionId: optStr(m, "sessionId"),
    spriteSeed: optStr(m, "spriteSeed") ?? `emp-${reqStr(f, "slug")}`,
    deskIndex: optNum(m, "deskIndex", 0),
    teamId: optStr(m, "teamId"),
    status: optStr(m, "status") === "working" ? "working" : "idle",
    createdAt: optNum(m, "createdAt", Date.now()),
  };
}

function taskToDoc(t: Task): FrontmatterDoc {
  const metadata: Record<string, Scalar> = {
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt,
  };
  if (t.assigneeId !== null) metadata.assigneeId = t.assigneeId;
  if (t.runId !== null) metadata.runId = t.runId;
  if (t.summary !== null) metadata.summary = t.summary;
  if (t.blockedQuestion !== null) metadata.blockedQuestion = t.blockedQuestion;
  if (t.artifacts.length > 0) metadata.artifacts = JSON.stringify(t.artifacts);
  if (t.attempts > 0) metadata.attempts = t.attempts;
  if (t.nextAttemptAt !== null) metadata.nextAttemptAt = t.nextAttemptAt;
  if (t.lastError !== null) metadata.lastError = t.lastError;
  if (t.startedAt !== null) metadata.startedAt = t.startedAt;
  if (t.completedAt !== null) metadata.completedAt = t.completedAt;
  return {
    fields: {
      schema: "agentcompanies/v1",
      kind: "task",
      slug: t.id,
      name: t.title,
    },
    metadata,
    body: t.description ? `${t.description}\n` : "",
  };
}

const TASK_STATUSES: ReadonlyArray<TaskStatus> = [
  "todo",
  "queued",
  "running",
  "blocked",
  "done",
  "failed",
  "dead",
  "cancelled",
];

function docToTask(doc: FrontmatterDoc, companyId: string): Task {
  const f = doc.fields;
  const m = doc.metadata;
  const statusRaw = optStr(m, "status") ?? "todo";
  const status = TASK_STATUSES.find((s) => s === statusRaw) ?? "todo";
  const prioRaw = optStr(m, "priority");
  const priority: TaskPriority = prioRaw === "low" || prioRaw === "high" ? prioRaw : "medium";
  const body = doc.body.trim();
  return {
    id: reqStr(f, "slug"),
    companyId,
    title: reqStr(f, "name"),
    description: body === "" ? null : body,
    status,
    priority,
    assigneeId: optStr(m, "assigneeId"),
    runId: optStr(m, "runId"),
    summary: optStr(m, "summary"),
    blockedQuestion: optStr(m, "blockedQuestion"),
    artifacts: strArray(m, "artifacts"),
    attempts: optNum(m, "attempts", 0),
    nextAttemptAt: m.nextAttemptAt === undefined ? null : optNum(m, "nextAttemptAt", 0),
    lastError: optStr(m, "lastError"),
    createdAt: optNum(m, "createdAt", Date.now()),
    startedAt: m.startedAt === undefined ? null : optNum(m, "startedAt", 0),
    completedAt: m.completedAt === undefined ? null : optNum(m, "completedAt", 0),
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
export function initStore(): void {
  ensureAppDirs();
  const loaded: Cache = {
    companies: new Map(),
    employees: new Map(),
    tasks: new Map(),
    routines: new Map(),
    teams: new Map(),
    teamChat: new Map(),
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

      const employees: Employee[] = [];
      for (const slug of safeReaddir(agentsDir(co.id))) {
        const ef = employeeFile(co.id, slug);
        if (!existsSync(ef)) continue;
        try {
          employees.push(docToEmployee(parseDoc(readFileSync(ef, "utf8")), co.id));
        } catch {
          /* skip corrupt agent file */
        }
      }
      employees.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      // a fresh boot has no live runs — anything marked working is stale
      for (const e of employees) e.status = "idle";
      loaded.employees.set(co.id, employees);

      const tasks: Task[] = [];
      for (const slug of safeReaddir(tasksDir(co.id))) {
        const tf = taskFile(co.id, slug);
        if (!existsSync(tf)) continue;
        try {
          tasks.push(docToTask(parseDoc(readFileSync(tf, "utf8")), co.id));
        } catch {
          /* skip corrupt task file */
        }
      }
      tasks.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      // recover runs that died with the previous process. A run that was
      // mid-flight counts as a failed attempt: requeue it (or dead-letter once
      // exhausted) so it resumes instead of being silently orphaned.
      for (const t of tasks) {
        if (t.status === "running") {
          const attempts = t.attempts + 1;
          t.runId = null;
          if (!t.assigneeId) {
            t.status = "todo";
          } else if (attempts >= MAX_TASK_ATTEMPTS) {
            t.status = "dead";
            t.attempts = attempts;
            t.lastError = "Interrupted by app restart (max attempts reached)";
            t.completedAt = Date.now();
          } else {
            t.status = "queued";
            t.attempts = attempts;
            t.nextAttemptAt = null;
            t.lastError = "Interrupted by app restart";
          }
          saveTask(t);
        } else if (t.status === "queued" && t.runId !== null) {
          t.runId = null; // drop a stale lock on a task that never actually started
          saveTask(t);
        }
      }
      loaded.tasks.set(co.id, tasks);

      const routines: Routine[] = [];
      for (const slug of safeReaddir(routinesDir(co.id))) {
        const rf = routineFile(co.id, slug);
        if (!existsSync(rf)) continue;
        try {
          routines.push(docToRoutine(parseDoc(readFileSync(rf, "utf8")), co.id));
        } catch {
          /* skip corrupt routine */
        }
      }
      loaded.routines.set(co.id, routines);

      const teams: Team[] = [];
      for (const slug of safeReaddir(teamsDir(co.id))) {
        const tf = teamFile(co.id, slug);
        if (!existsSync(tf)) continue;
        try {
          teams.push(docToTeam(parseDoc(readFileSync(tf, "utf8")), co.id));
        } catch {
          /* skip corrupt team */
        }
      }
      teams.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      loaded.teams.set(co.id, teams);
      for (const t of teams) loadRecentTeamChat(loaded, co.id, t.id);

      loadRecentActivity(loaded, co.id);
    } catch {
      /* skip corrupt company */
    }
  }

  cache = loaded;

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

  // companies created before teams existed get a founding team (all hires, led)
  for (const co of loaded.companies.values()) {
    const emps = loaded.employees.get(co.id) ?? [];
    if (emps.length > 0 && (loaded.teams.get(co.id) ?? []).length === 0) {
      try {
        foundingTeamFor(co);
      } catch {
        /* non-fatal */
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

/** Create the single founding team containing every current employee. */
export function foundingTeamFor(co: Company): Team {
  const emps = listEmployees(co.id);
  return createTeam({
    companyId: co.id,
    name: `${co.name} core team`,
    purpose: "The founding team building, shipping, and growing the company together.",
    leaderId: pickLeaderId(emps),
    memberIds: emps.map((e) => e.id),
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function loadRecentActivity(loaded: Cache, companyId: string): void {
  try {
    const text = readFileSync(activityFile(companyId), "utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    for (const line of lines.slice(-ACTIVITY_RING)) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && "kind" in parsed && "createdAt" in parsed) {
          const e = parsed as ActivityEvent;
          e.id = loaded.nextActivityId++;
          loaded.activity.push(e);
        }
      } catch {
        /* skip bad line */
      }
    }
    if (loaded.activity.length > ACTIVITY_RING)
      loaded.activity = loaded.activity.slice(-ACTIVITY_RING);
  } catch {
    /* no log yet */
  }
}

const TEAM_CHAT_RING = 200;

function loadRecentTeamChat(loaded: Cache, companyId: string, teamId: string): void {
  const msgs: TeamMessage[] = [];
  try {
    const text = readFileSync(teamChatFile(companyId, teamId), "utf8");
    for (const line of text.split("\n").slice(-TEAM_CHAT_RING)) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && "text" in parsed && "createdAt" in parsed) {
          const m = parsed as TeamMessage;
          m.id = loaded.nextTeamMessageId++;
          m.teamId = teamId;
          msgs.push(m);
        }
      } catch {
        /* skip bad line */
      }
    }
  } catch {
    /* no chat yet */
  }
  loaded.teamChat.set(teamId, msgs);
}

// ---- slug allocation ---------------------------------------------------------
function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  const root = slugify(base);
  if (!taken(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

// ---- companies -------------------------------------------------------------
export function createCompany(input: {
  name: string;
  mission: string;
  businessType: BusinessTypeId;
  founderName: string;
  founderSpriteSeed: string;
}): Company {
  const id = uniqueSlug(input.name, (s) => c().companies.has(s) || existsSync(companyDir(s)));
  const co: Company = {
    id,
    name: input.name,
    mission: input.mission,
    businessType: input.businessType,
    workspaceDir: companyWorkspace(id),
    founderName: input.founderName,
    founderSpriteSeed: input.founderSpriteSeed,
    autopilot: true,
    cash: 1000,
    ships: 0,
    users: 0,
    budget: { mode: "infinite" },
    spentUsd: 0,
    onboarded: false,
    createdAt: Date.now(),
  };
  mkdirSync(companyWorkspace(id), { recursive: true });
  mkdirSync(tasksDir(id), { recursive: true });
  mkdirSync(agentsDir(id), { recursive: true });
  saveCompany(co);
  c().companies.set(id, co);
  c().employees.set(id, []);
  c().tasks.set(id, []);
  c().routines.set(id, []);
  c().teams.set(id, []);
  seedDefaultRoutines(id, input.businessType);
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
  const id = uniqueSlug(input.name, (s) => list.some((r) => r.id === s));
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
function createTeam(input: {
  companyId: string;
  name: string;
  purpose: string;
  leaderId: string | null;
  memberIds: string[];
}): Team {
  const list = c().teams.get(input.companyId);
  if (!list) throw new Error(`company ${input.companyId} not found`);
  const id = uniqueSlug(input.name, (s) => list.some((t) => t.id === s));
  const team: Team = {
    id,
    companyId: input.companyId,
    name: input.name,
    purpose: input.purpose,
    leaderId: input.leaderId,
    memberIds: [...new Set(input.memberIds)],
    createdAt: Date.now(),
  };
  saveTeam(team);
  list.push(team);
  c().teamChat.set(id, []);
  // stamp each member's teamId so the office + scheduler can group them
  for (const mid of team.memberIds) patchEmployee(mid, { teamId: id });
  return team;
}

export function listTeams(companyId: string): Team[] {
  return [...(c().teams.get(companyId) ?? [])];
}

function getTeam(teamId: string): Team | null {
  for (const list of c().teams.values()) {
    const found = list.find((t) => t.id === teamId);
    if (found) return found;
  }
  return null;
}

function patchTeam(teamId: string, patch: Partial<Team>): Team | null {
  for (const list of c().teams.values()) {
    const idx = list.findIndex((t) => t.id === teamId);
    if (idx >= 0) {
      const cur = list[idx];
      if (!cur) return null;
      const next = { ...cur, ...patch, id: cur.id, companyId: cur.companyId };
      list[idx] = next;
      saveTeam(next);
      return next;
    }
  }
  return null;
}

export function addTeamMember(teamId: string, employeeId: string): Team | null {
  const t = getTeam(teamId);
  if (!t) return null;
  const memberIds = t.memberIds.includes(employeeId) ? t.memberIds : [...t.memberIds, employeeId];
  patchEmployee(employeeId, { teamId });
  return patchTeam(teamId, { memberIds });
}

/** The team an employee belongs to, if any. */
export function teamForEmployee(employeeId: string): Team | null {
  const emp = getEmployee(employeeId);
  if (!emp || !emp.teamId) return null;
  return getTeam(emp.teamId);
}

// ---- team chat room --------------------------------------------------------
/** Post a message to a team's persistent chat room (read by teammates mid-run). */
export function postTeamMessage(
  teamId: string,
  fromEmployeeId: string | null,
  text: string,
): TeamMessage {
  const msg: TeamMessage = { teamId, fromEmployeeId, text, createdAt: Date.now() };
  const ring = c().teamChat.get(teamId) ?? [];
  const stored: TeamMessage = { ...msg, id: c().nextTeamMessageId++ };
  ring.push(stored);
  if (ring.length > TEAM_CHAT_RING) ring.splice(0, ring.length - TEAM_CHAT_RING);
  c().teamChat.set(teamId, ring);
  const team = getTeam(teamId);
  if (team && !writesSuspended) {
    const { id: _drop, ...persisted } = stored;
    try {
      appendFileSync(teamChatFile(team.companyId, teamId), JSON.stringify(persisted) + "\n");
    } catch {
      /* chat loss is acceptable */
    }
  }
  return stored;
}

/** Recent room messages, optionally only those after a given timestamp. */
export function recentTeamMessages(teamId: string, limit = 20, since = 0): TeamMessage[] {
  const ring = c().teamChat.get(teamId) ?? [];
  const filtered = since > 0 ? ring.filter((m) => m.createdAt > since) : ring;
  return filtered.slice(-limit);
}

export function getCompany(id: string): Company | null {
  return c().companies.get(id) ?? null;
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

export function setCompanyOnboarded(id: string, onboarded: boolean): void {
  patchCompany(id, { onboarded });
}
export function setAutopilot(id: string, on: boolean): void {
  patchCompany(id, { autopilot: on });
}
/** Record one shipped unit of work plus the adoption/revenue it drove. */
export function recordShip(id: string, usersDelta: number, cashDelta: number): void {
  const co = c().companies.get(id);
  if (!co) return;
  patchCompany(id, {
    ships: co.ships + 1,
    users: co.users + Math.max(0, Math.round(usersDelta)),
    cash: Math.round((co.cash + cashDelta) * 100) / 100,
  });
}
/** Adjust cash (hiring costs, revenue ticks). Returns the updated company. */
export function adjustCash(id: string, delta: number): Company {
  const co = c().companies.get(id);
  if (!co) throw new Error(`company ${id} not found`);
  return patchCompany(id, { cash: Math.round((co.cash + delta) * 100) / 100 });
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
/** Apply a periodic metrics pulse (revenue trickle + organic growth). */
export function applyPulse(id: string, usersDelta: number, cashDelta: number): Company | null {
  const co = c().companies.get(id);
  if (!co) return null;
  return patchCompany(id, {
    users: co.users + Math.max(0, Math.round(usersDelta)),
    cash: Math.round((co.cash + cashDelta) * 100) / 100,
  });
}
/** Overwrite with REAL absolute numbers from configured metrics sources. */
export function setRealMetrics(
  id: string,
  snapshot: { users: number | null; revenue: number | null },
): Company | null {
  const co = c().companies.get(id);
  if (!co) return null;
  const patch: Partial<Company> = {};
  if (snapshot.users !== null) patch.users = Math.max(0, Math.round(snapshot.users));
  if (snapshot.revenue !== null) patch.cash = Math.round(snapshot.revenue * 100) / 100;
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
  model?: string | null;
  spriteSeed: string;
  deskIndex: number;
}): Employee {
  const list = c().employees.get(input.companyId);
  if (!list) throw new Error(`company ${input.companyId} not found`);
  const id = uniqueSlug(
    input.name,
    (s) => list.some((e) => e.id === s) || existsSync(employeeAgentDir(input.companyId, s)),
  );
  const e: Employee = {
    id,
    companyId: input.companyId,
    name: input.name,
    role: input.role,
    title: input.title,
    persona: input.persona,
    runner: input.runner,
    model: input.model ?? null,
    sessionId: null,
    spriteSeed: input.spriteSeed,
    deskIndex: input.deskIndex,
    teamId: null,
    status: "idle",
    createdAt: Date.now(),
  };
  mkdirSync(employeeMemoryDir(input.companyId, id), { recursive: true });
  mkdirSync(employeeSessionDir(input.companyId, id), { recursive: true });
  saveEmployee(e);
  list.push(e);
  return e;
}

export function getEmployee(id: string): Employee | null {
  for (const list of c().employees.values()) {
    const found = list.find((e) => e.id === id);
    if (found) return found;
  }
  return null;
}

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
  for (const list of c().employees.values()) {
    const idx = list.findIndex((e) => e.id === id);
    if (idx >= 0) {
      const cur = list[idx];
      if (!cur) return;
      const next = { ...cur, ...patch, id: cur.id, companyId: cur.companyId };
      list[idx] = next;
      saveEmployee(next);
      return;
    }
  }
}

export function setEmployeeStatus(id: string, status: Employee["status"]): void {
  patchEmployee(id, { status });
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
    (s) => list.some((x) => x.id === s) || existsSync(join(tasksDir(t.companyId), s)),
  );
  const task: Task = {
    id,
    companyId: t.companyId,
    title: t.title,
    description: t.description ?? null,
    status: "todo",
    priority: t.priority ?? "medium",
    assigneeId: t.assigneeId ?? null,
    runId: null,
    summary: null,
    blockedQuestion: null,
    artifacts: [],
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
  };
  saveTask(task);
  list.push(task);
  return task;
}

export function getTask(id: string): Task | null {
  for (const list of c().tasks.values()) {
    const found = list.find((t) => t.id === id);
    if (found) return found;
  }
  return null;
}

export function listTasks(companyId: string): Task[] {
  return (c().tasks.get(companyId) ?? []).toSorted((a, b) => b.createdAt - a.createdAt);
}

export function listTasksForEmployee(employeeId: string): Task[] {
  const out: Task[] = [];
  for (const list of c().tasks.values())
    for (const t of list) if (t.assigneeId === employeeId) out.push(t);
  return out.toSorted((a, b) => b.createdAt - a.createdAt);
}

const TASK_PRIORITY_ORDER: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

/** Queued tasks eligible to start now (a backoff retry waits for nextAttemptAt). */
export function listQueuedTasks(): Task[] {
  const now = Date.now();
  const out: Task[] = [];
  for (const list of c().tasks.values())
    for (const t of list)
      if (t.status === "queued" && (t.nextAttemptAt === null || t.nextAttemptAt <= now))
        out.push(t);
  return out.toSorted(
    (a, b) =>
      TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority] ||
      a.createdAt - b.createdAt,
  );
}

function patchTask(id: string, patch: Partial<Task>): Task | null {
  for (const list of c().tasks.values()) {
    const idx = list.findIndex((t) => t.id === id);
    if (idx >= 0) {
      const cur = list[idx];
      if (!cur) return null;
      const next = { ...cur, ...patch, id: cur.id, companyId: cur.companyId };
      list[idx] = next;
      saveTask(next);
      return next;
    }
  }
  return null;
}

/**
 * Atomic assign: only todo/blocked/failed/dead are claimable. A manual claim of
 * a failed/dead task is the founder reviving it, so the retry counter resets.
 * Returns task or null on conflict.
 */
export function claimTask(taskId: string, employeeId: string): Task | null {
  const t = getTask(taskId);
  if (!t) return null;
  const claimable =
    t.status === "todo" || t.status === "blocked" || t.status === "failed" || t.status === "dead";
  if (!claimable || (t.assigneeId !== null && t.assigneeId !== employeeId)) return null;
  const revived = t.status === "failed" || t.status === "dead";
  return patchTask(taskId, {
    assigneeId: employeeId,
    status: "queued",
    ...(revived ? { attempts: 0, nextAttemptAt: null, lastError: null } : {}),
  });
}

/** Acquire execution lock: queued -> running, stamp runId. Null if lost race or backing off. */
export function lockTaskForRun(taskId: string, runId: string): Task | null {
  const t = getTask(taskId);
  if (!t || t.status !== "queued" || t.runId !== null) return null;
  if (t.nextAttemptAt !== null && t.nextAttemptAt > Date.now()) return null;
  return patchTask(taskId, { status: "running", runId, startedAt: Date.now() });
}

/** Release lock at run end — only the owning run may release. */
export function releaseTask(
  taskId: string,
  runId: string,
  status: TaskStatus,
  summary: string | null,
  blockedQuestion: string | null,
): void {
  const t = getTask(taskId);
  if (!t || t.runId !== runId) return;
  patchTask(taskId, { status, summary, blockedQuestion, runId: null, completedAt: Date.now() });
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
  lastError: string | null,
): void {
  const t = getTask(taskId);
  if (!t || t.runId !== runId) return;
  patchTask(taskId, { status: "queued", runId: null, attempts, nextAttemptAt, lastError });
}

/** A failed run that exhausted its attempts: dead-letter it. Only the owning run may. */
export function deadLetterTask(
  taskId: string,
  runId: string,
  attempts: number,
  lastError: string | null,
): void {
  const t = getTask(taskId);
  if (!t || t.runId !== runId) return;
  patchTask(taskId, {
    status: "dead",
    runId: null,
    attempts,
    lastError,
    summary: lastError,
    completedAt: Date.now(),
  });
}

/**
 * The founder answers a blocked task's question: the blocked task closes and a
 * continuation task (same employee, same session → full context) is created.
 * Returns the continuation, or null if the task wasn't awaiting an answer.
 */
export function resolveBlockedWithAnswer(taskId: string, answer: string): Task | null {
  const t = getTask(taskId);
  if (!t || t.status !== "blocked" || !t.assigneeId) return null;
  patchTask(taskId, {
    status: "done",
    summary: `Founder answered: ${answer}`,
    blockedQuestion: null,
    completedAt: Date.now(),
  });
  return createTask({
    companyId: t.companyId,
    title: `Continue: ${t.title.slice(0, 60)}`,
    description: `You previously asked the founder:\n> ${t.blockedQuestion ?? "(question lost)"}\n\nThe founder answered:\n> ${answer}\n\nContinue the work with that answer. Original task: ${t.title}`,
    priority: "high",
    assigneeId: t.assigneeId,
  });
}

// ---- activity log ----------------------------------------------------------
export function logActivity(e: ActivityEvent): number {
  const id = c().nextActivityId++;
  const entry: ActivityEvent = { ...e, id };
  c().activity.push(entry);
  if (c().activity.length > ACTIVITY_RING) c().activity = c().activity.slice(-ACTIVITY_RING);

  // append to the owning company's activity.jsonl (employee → company, else default)
  const companyId = entry.employeeId
    ? getEmployee(entry.employeeId)?.companyId
    : getDefaultCompany()?.id;
  if (companyId && !writesSuspended) {
    const { id: _drop, ...persisted } = entry;
    try {
      appendFileSync(activityFile(companyId), JSON.stringify(persisted) + "\n");
    } catch {
      /* log loss is acceptable */
    }
  }
  return id;
}

/** Recent activity rows of a kind for a company. */
export function recentActivity(companyId: string, kind: string, limit = 12): ActivityEvent[] {
  const ids = new Set(listEmployees(companyId).map((e) => e.id));
  return c()
    .activity.filter((e) => e.kind === kind && e.employeeId != null && ids.has(e.employeeId))
    .slice(-limit);
}
