# SPEC: control-plane

I have everything. Here's the distilled design.

---

# Office: Minimal Electron Game Main-Process Design

Distilled from Paperclip's control plane. Paperclip is a Postgres + Drizzle multi-tenant server with governance, budgets, git worktrees, remote SSH execution, session compaction, and an 11k-line heartbeat service. **~95% of that is irrelevant to a single-player sandbox game.** The load-bearing core is four ideas: an atomic single-assignee checkout, an adapter that spawns `pi --mode json -p` and parses JSONL, a concurrency-capped scheduler, and a token→cost ledger. Everything below keeps those, drops the rest.

---

## 1. Data Model

**Storage recommendation: `better-sqlite3`.**

- **vs `node:sqlite`**: builtin is still flagged experimental (Node 22/24) and its API surface keeps shifting. In Electron the more pressing problem: Electron ships its *own* Node, so a builtin tied to your local Node version isn't guaranteed to match Electron's runtime. Don't bet your save format on an experimental API.
- **vs JSON-file stores (inteligir approach)**: fine for config, wrong for this. You have concurrent writers — 3 runs finishing simultaneously each appending events + cost rows. JSON stores force you to hand-roll read-modify-write locking and you lose atomic conditional updates. The single-assignee checkout (the one piece of correctness that actually matters) is *literally one SQL UPDATE...WHERE...RETURNING* in SQLite and a race-condition minefield in JSON.
- **`better-sqlite3`**: synchronous (no async ceremony in main-process transaction logic), battle-tested, fast. The only real cost is the native module. Solve it once: `electron-rebuild` (or `@electron/rebuild`) in postinstall, list it as an `asarUnpack` external. This is a known, paved path — every serious Electron app with a DB does it. Pay it once at setup; never think about it again.

Verdict: native-module pain is a one-time build-config tax. JSON-store pain is a permanent concurrency tax on the hot path. Take the one-time tax.

```ts
// schema.sql — run once on app boot via db.exec()

CREATE TABLE company (
  id            TEXT PRIMARY KEY,           -- single row for the sandbox; 'default'
  name          TEXT NOT NULL,
  spent_cents   INTEGER NOT NULL DEFAULT 0, -- denormalized running total for the meter
  created_at    INTEGER NOT NULL            -- epoch ms
);

CREATE TABLE employee (                     -- = paperclip "agent"
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'general',  -- flavor: 'engineer','designer'...
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'idle',     -- 'idle' | 'working'
  -- pi config (mirrors adapterConfig, flattened):
  model         TEXT NOT NULL,              -- 'anthropic/claude-...' provider/model
  thinking      TEXT,                       -- 'off'|'low'|'medium'|'high'|null
  session_id    TEXT,                       -- last pi session file path, for resume
  created_at    INTEGER NOT NULL
);

CREATE TABLE task (                         -- = paperclip "issue"
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'todo',
                -- 'todo'|'queued'|'running'|'blocked'|'done'|'failed'|'cancelled'
  priority      TEXT NOT NULL DEFAULT 'medium',
  assignee_id   TEXT REFERENCES employee(id),  -- single assignee
  run_id        TEXT,                       -- THE execution lock (see §4)
  summary       TEXT,                       -- final pi message on completion
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER
);

CREATE TABLE run (                          -- = paperclip "heartbeat_run", slimmed
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id),
  employee_id   TEXT NOT NULL REFERENCES employee(id),
  status        TEXT NOT NULL DEFAULT 'queued',
                -- 'queued'|'running'|'succeeded'|'failed'|'timed_out'|'cancelled'
  exit_code     INTEGER,
  error         TEXT,
  -- usage snapshot (one run = one pi exec):
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  session_id    TEXT,                       -- pi session path written this run
  started_at    INTEGER,
  finished_at   INTEGER
);

CREATE TABLE activity_log (                 -- live event stream + audit
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic seq for ordering
  run_id        TEXT,
  task_id       TEXT,
  employee_id   TEXT,
  kind          TEXT NOT NULL,  -- 'log'|'tool_call'|'status'|'cost'|'lifecycle'
  stream        TEXT,           -- 'stdout'|'stderr'|'system'
  message       TEXT,
  payload       TEXT,           -- JSON blob
  created_at    INTEGER NOT NULL
);

CREATE INDEX task_status_idx     ON task(status);
CREATE INDEX task_assignee_idx   ON task(assignee_id, status);
CREATE INDEX run_status_idx      ON run(status);
CREATE INDEX activity_run_idx    ON activity_log(run_id, id);
```

**What I cut from Paperclip's schemas and why:**
- `agents`: dropped `budgetMonthlyCents`, `permissions`, `reportsTo`, `defaultEnvironmentId`, `adapterConfig`/`runtimeConfig` jsonb blobs (flattened to `model`/`thinking`/`session_id`). Kept `status` and session.
- `issues` (84 columns!): kept ~10. Dropped every `monitor*`, `origin*`, `executionWorkspace*`, `requestDepth`, `billingCode`, `sourceTrust`, `parentId`, projects/goals FKs. Folded `checkoutRunId` + `executionRunId` into one `run_id` lock.
- `heartbeat_runs` (50 columns): kept the run identity + usage + outcome. Dropped all `liveness*`, `process*`, `scheduledRetry*`, `log*` (store excerpts inline), `continuationAttempt`.
- `cost_events`: merged into `run` for the per-run snapshot, kept `activity_log` rows of `kind='cost'` for the streaming meter feed. No separate table needed at this scale.

`cost_cents` lives on `run` (per-execution truth) and `company.spent_cents` is the denormalized meter total. That's the whole cost model.

---

## 2. Run Execution Algorithm (adapted from `heartbeat.ts`)

Paperclip's heartbeat is: `startNextQueuedRunForAgent` → concurrency check (`maxConcurrentRuns - runningCount`) → set run `running` → `adapter.execute({ onLog, onMeta, onSpawn })` → derive `outcome` from `exitCode`/`timedOut`/`errorMessage` → `setRunStatus` + `updateRuntimeState` (writes `cost_events`, bumps `spentMonthlyCents`). I keep that spine and drop the workspace/session/liveness machinery.

```ts
// scheduler.ts — runs in Electron main process
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";

const GLOBAL_CONCURRENCY_CAP = 3;

export class Scheduler {
  private active = new Map<string, AbortController>(); // runId -> ctrl
  private busyEmployees = new Set<string>();           // per-employee single-active lock
  readonly events = new EventEmitter();                // renderer subscribes via IPC

  constructor(private db: Database.Database, private pi: PiAdapter) {}

  // ---- 1. ASSIGN + ENQUEUE (player clicks "assign task to Alice") ----
  assign(taskId: string, employeeId: string) {
    // Single-assignee checkout: atomic conditional update (see §4).
    const claimed = this.db.prepare(`
      UPDATE task SET assignee_id = ?, status = 'queued'
      WHERE id = ? AND status IN ('todo','blocked','failed')
            AND (assignee_id IS NULL OR assignee_id = ?)
      RETURNING id
    `).get(employeeId, taskId, employeeId);
    if (!claimed) throw new Error("task not assignable");
    this.log({ taskId, employeeId, kind: "status", message: "queued" });
    this.tick(); // try to start something
  }

  // ---- 2. SCHEDULER: respect global cap + per-employee single-active ----
  tick() {
    while (this.active.size < GLOBAL_CONCURRENCY_CAP) {
      // pick highest-priority queued task whose employee isn't already busy
      const next = this.db.prepare(`
        SELECT t.* FROM task t
        WHERE t.status = 'queued'
          AND t.assignee_id NOT IN (${[...this.busyEmployees].map(() => "?").join(",") || "''"})
        ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                 t.created_at
        LIMIT 1
      `).get(...this.busyEmployees) as TaskRow | undefined;
      if (!next) break;
      this.startRun(next);
    }
  }

  // ---- 3. START a pi run for this employee session ----
  private startRun(task: TaskRow) {
    const employee = this.getEmployee(task.assignee_id!);
    const runId = crypto.randomUUID();
    const ctrl = new AbortController();

    // acquire execution lock: stamp run_id onto task atomically
    const locked = this.db.prepare(`
      UPDATE task SET status='running', run_id=?, started_at=?
      WHERE id=? AND status='queued' AND run_id IS NULL
      RETURNING id
    `).get(runId, Date.now(), task.id);
    if (!locked) return; // lost the race; another tick handles it

    this.db.prepare(`INSERT INTO run (id,task_id,employee_id,status,started_at)
                     VALUES (?,?,?,'running',?)`).run(runId, task.id, employee.id, Date.now());
    this.db.prepare(`UPDATE employee SET status='working' WHERE id=?`).run(employee.id);
    this.active.set(runId, ctrl);
    this.busyEmployees.add(employee.id);
    this.emit({ runId, taskId: task.id, employeeId: employee.id, kind: "lifecycle", message: "run.start" });

    // fire-and-forget; completion handled in .then/.catch
    void this.execute(runId, task, employee, ctrl)
      .catch((err) => this.finishRun(runId, task, employee, { failed: true, error: String(err) }))
      .finally(() => {
        this.active.delete(runId);
        this.busyEmployees.delete(employee.id);
        this.tick(); // free slot -> pull next
      });
  }

  // ---- 4. INVOKE pi + STREAM events (adapted pi-local execute) ----
  private async execute(runId: string, task: TaskRow, emp: EmployeeRow, ctrl: AbortController) {
    let seq = 0;
    const result = await this.pi.execute({
      runId,
      model: emp.model,
      thinking: emp.thinking,
      sessionId: emp.session_id,           // resume employee's session if present
      prompt: `${task.title}\n\n${task.description ?? ""}`,
      signal: ctrl.signal,
      // stream callbacks -> activity_log + EventEmitter -> renderer
      onLog: (stream, chunk) =>
        this.emit({ runId, taskId: task.id, employeeId: emp.id, seq: seq++,
                    kind: "log", stream, message: chunk }),
      onToolCall: (tool) =>
        this.emit({ runId, taskId: task.id, employeeId: emp.id, seq: seq++,
                    kind: "tool_call", message: tool.name, payload: tool }),
    });

    // ---- 5. POST-EXEC: derive outcome (mirrors heartbeat lines 8865-8870) ----
    const failed = result.timedOut || (result.exitCode ?? 0) !== 0 || !!result.errorMessage;
    this.finishRun(runId, task, emp, {
      failed,
      timedOut: result.timedOut,
      error: result.errorMessage,
      summary: result.summary,
      sessionId: result.sessionId,
      usage: result.usage,        // { inputTokens, outputTokens, cachedTokens }
      costUsd: result.costUsd,    // pi reports this directly (see §5)
    });
  }

  // ---- 6. FINALIZE: status + cost + release lock ----
  private finishRun(runId: string, task: TaskRow, emp: EmployeeRow, r: FinishArgs) {
    const costCents = Math.max(0, Math.round((r.costUsd ?? 0) * 100));
    const runStatus = r.timedOut ? "timed_out" : r.failed ? "failed" : "succeeded";
    // Task status: blocked is a soft-fail the player can retry; failed is hard.
    const taskStatus = r.failed ? (this.looksBlocked(r) ? "blocked" : "failed") : "done";

    this.db.transaction(() => {
      this.db.prepare(`UPDATE run SET status=?, error=?, summary IS summary,
        input_tokens=?, output_tokens=?, cached_tokens=?, cost_cents=?,
        session_id=?, finished_at=? WHERE id=?`)
        .run(runStatus, r.error ?? null,
             r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0,
             r.usage?.cachedTokens ?? 0, costCents, r.sessionId ?? null, Date.now(), runId);

      this.db.prepare(`UPDATE task SET status=?, summary=?, run_id=NULL,
        completed_at=? WHERE id=? AND run_id=?`)             // release lock only if we own it
        .run(taskStatus, r.summary ?? null, Date.now(), task.id, runId);

      this.db.prepare(`UPDATE employee SET status='idle', session_id=? WHERE id=?`)
        .run(r.sessionId ?? emp.session_id, emp.id);

      this.db.prepare(`UPDATE company SET spent_cents = spent_cents + ? WHERE id='default'`)
        .run(costCents);
    })();

    this.emit({ runId, taskId: task.id, employeeId: emp.id, kind: "cost",
                payload: { costCents, ...r.usage } });
    this.emit({ runId, taskId: task.id, employeeId: emp.id, kind: "status", message: taskStatus });
  }

  private emit(e: ActivityEvent) { this.log(e); this.events.emit("activity", e); }
  private log(e: ActivityEvent) {
    this.db.prepare(`INSERT INTO activity_log
      (run_id,task_id,employee_id,kind,stream,message,payload,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      e.runId??null, e.taskId??null, e.employeeId??null, e.kind,
      e.stream??null, e.message??null, e.payload?JSON.stringify(e.payload):null, Date.now());
  }
}
```

Renderer subscribes via IPC: `scheduler.events.on("activity", e => webContents.send("activity", e))`. On boot, replay `activity_log` ordered by `id` to rebuild UI state. `id` autoincrement gives you a free monotonic global sequence (Paperclip uses `lastOutputSeq` per-run; the autoincrement PK is simpler).

---

## 3. How pi_local actually runs pi — and what to copy

**It spawns the CLI.** No SDK. From `execute.ts` + `index.ts`:

```
command = config.command || "pi"   // SANDBOX_INSTALL_COMMAND = npm i -g @earendil-works/pi-coding-agent
args:
  --mode json                       // structured JSONL on stdout
  -p                                // non-interactive: process prompt, exit
  --append-system-prompt <text>     // agent instructions extend pi's system prompt
  --provider <name> --model <id>    // split from "provider/model" string
  --thinking <level>                // optional
  --tools read,bash,edit,write,grep,find,ls
  --session <path/to/file.jsonl>    // resume across runs; ~/.pi/paperclips/<ts>-<agent>.jsonl
  <userPrompt>                       // the task, last positional arg
```

It streams by **buffering stdout into complete lines** and emitting each line via `onLog`. After exit, `parsePiJsonl(stdout)` walks the JSONL events:
- `turn_end` carries `message.usage` → `{ input, output, cacheRead }` and `usage.cost.total` (**pi computes the dollar cost itself**).
- `tool_execution_start`/`_end` → tool calls.
- `agent_end`/`turn_end` last assistant text → `finalMessage` (= run summary).
- Returns `{ usage: {inputTokens, outputTokens, cachedInputTokens}, costUsd, summary, exitCode, sessionId }`.

Session resume: pass the saved session file path back via `--session`. Pi validates the cwd in the session header; on mismatch or "unknown session" error it retries fresh. **For the game, sessions are how an employee "remembers" prior tasks** — keep it, store the path on `employee.session_id`.

**inteligir's in-process approach vs spawn:** inteligir runs the agent loop in-process (SDK calls inside the same Node runtime). Tempting for an Electron app — no child processes, direct streaming, no CLI dependency. **But: don't.** For multi-employee concurrency you want each pi run as an isolated child process because:
1. **Isolation** — a hung/looping agent is one `AbortController`/`SIGTERM` away from death without touching your main process or the other 2 runs.
2. **Crash containment** — an OOM or unhandled throw in agent code doesn't take down the Electron main process (which owns your DB and all windows).
3. **The tooling already exists** — pi's `read,bash,edit,write,...` toolset, sandboxing, and JSONL protocol are done. Reimplementing in-process means rebuilding the entire agent harness.

**Recommendation: copy the pi-local spawn approach, strip the remote/SSH/managed-home machinery.** Your `PiAdapter.execute` is ~80 lines: build args, `spawn("pi", args, { signal })`, line-buffer stdout → `onLog`, on close run a trimmed `parsePiJsonl` (copy that file nearly verbatim — it's already minimal and correct), return the result struct. Wire `onSpawn`→store pid for kill, `signal`→cancellation.

---

## 4. Single-Assignee Checkout + Status State Machine

Paperclip's checkout (`issues.ts:5324`) is an **atomic optimistic-concurrency UPDATE**:

```sql
UPDATE issues SET assignee=?, checkout_run_id=?, execution_run_id=?, status='in_progress'
WHERE id=? AND status IN (expected)
      AND (assignee IS NULL OR (assignee=? AND (checkout_run IS NULL OR checkout_run=?)))
      AND (execution_run_id IS NULL OR execution_run_id=?)
RETURNING *
```

If `RETURNING` is empty, someone else holds the lock → conflict. **The `run_id` column IS the lock.** No mutex, no advisory lock — the row's `WHERE`-guarded write is the entire mechanism. SQLite gives you the same atomicity. Two callers race to stamp `run_id`; exactly one wins.

Distilled to minimum — collapse Paperclip's dual `checkoutRunId`/`executionRunId` into one `task.run_id`:

```ts
// Claim a task for an employee (assignment). Lock = setting run_id later.
UPDATE task SET assignee_id=?, status='queued'
WHERE id=? AND status IN ('todo','blocked','failed')
      AND (assignee_id IS NULL OR assignee_id=?)
RETURNING id;                                   // empty => already taken

// Acquire execution lock at run start (the actual single-active guarantee):
UPDATE task SET status='running', run_id=?
WHERE id=? AND status='queued' AND run_id IS NULL
RETURNING id;                                   // empty => lost race

// Release at run end — only the owning run may release:
UPDATE task SET status=?, run_id=NULL WHERE id=? AND run_id=?;
```

**Status state machine (minimal):**

```
                  assign()            startRun()
   todo ────────────────────► queued ──────────► running
    ▲                            │ (lock run_id)    │
    │ (re-assign)                │                  │ finishRun()
    │                           cancel              ├──► done      (exit 0)
 blocked ◄───────────┐          │                  ├──► blocked   (soft fail / needs input)
 failed  ◄───────────┤          ▼                  ├──► failed    (hard fail / timeout)
    │  (player retry: └──────► cancelled ◄──────────┘
    │   blocked/failed → todo)
   done  (terminal)
```

Rules, total:
- Only `todo`/`blocked`/`failed` are assignable (re-try a stuck task).
- `queued→running` requires `run_id IS NULL` (the lock).
- Terminal-from-run: `done` | `blocked` | `failed` | `timed_out→failed`.
- `cancelled` reachable from `queued`/`running` (player abort → `ctrl.abort()`).
- Per-employee single-active enforced in the scheduler via `busyEmployees` Set *and* defended by the DB lock (the Set is the fast path, the SQL `WHERE run_id IS NULL` is the source of truth across a restart).

Paperclip's `assertTransition` is essentially a no-op (just validates the target is a known status) — the real invariants live in the conditional UPDATEs, not a transition table. Copy that philosophy: **enforce state in the WHERE clause, not in branching code.** Makes illegal states unwritable.

---

## 5. Cost / Usage Tracking

Paperclip's pipeline (verified in `heartbeat.ts` + `costs.ts`):

1. Adapter returns `costUsd` (pi computed it from `usage.cost.total` in the JSONL — **you don't price tokens yourself**).
2. `normalizeBilledCostCents(costUsd)` = `Math.max(0, Math.round(costUsd * 100))` (heartbeat.ts:1707).
3. `costService.createEvent` inserts a `cost_events` row **and** bumps `agent.spentMonthlyCents` + `company.spentMonthlyCents` (costs.ts:86,94) in the same transaction.
4. `agentRuntimeState` accumulates `totalInputTokens/Output/Cached/CostCents` via `col + delta`.

**For the game's meter, you need exactly:**
- Per-run snapshot: `run.{input_tokens, output_tokens, cached_tokens, cost_cents}` — already in §1.
- Running total: `company.spent_cents += costCents` in `finishRun` — the meter reads this one integer.
- Live tick: emit a `kind:'cost'` activity event so the meter animates as runs finish.

```ts
const costCents = Math.max(0, Math.round((result.costUsd ?? 0) * 100));
// ...inside finishRun transaction:
UPDATE company SET spent_cents = spent_cents + ? WHERE id='default';
```

That's the whole cost system. If pi ever returns `costUsd: 0` (some providers/local models), fall back to a token-price table keyed on `employee.model` — but pi's `usage.cost.total` covers the hosted providers, so defer that until you actually hit a zero. **No budgets, no incidents, no monthly reset** — it's a sandbox; the meter is a score display, not a gate.

---

## 6. Drop vs Keep

**DROP (sandbox = no need):**
- **Approvals / governance** — `approvals`, `issue_approvals`, board-approval-for-agents, `principal_permission_grants`, `agent_memberships`. No human-in-loop gate; the player IS the authority.
- **Budgets as hard-stops** — `budget_policies`, `budget_incidents`, `budgetMonthlyCents` enforcement, `getAgentInvokability` budget checks. Track cost for the meter; never block on it.
- **Multi-company isolation** — single hardcoded `company` row. Drop `companyId` FKs everywhere they exist purely for tenancy (keep one for the meter rollup).
- **Git-worktree / workspace machinery** — `execution_workspaces`, `project_workspaces`, `environment_leases`, `workspaceOperationRecorder`, `assertGitSensitiveAdapterWorkspaceValid`, remote SSH/`prepareAdapterExecutionTargetRuntime`, managed HOME, paperclip bridge. The entire remote-execution half of `execute.ts` (lines ~396-470, 521-538). Run pi locally in a fixed cwd (or one dir per employee for flavor).
- **Liveness/watchdog/recovery** — `heartbeat_run_watchdog_decisions`, `livenessState`, `processLossRetry`, `scheduledRetry`, `continuationAttempt`, stranded-issue recovery, stale-run evaluation. A run either finishes or you `SIGTERM` it; no resurrection logic.
- **Session compaction/rotation** — `parseSessionCompactionPolicy`, rotation reasons. Let pi sessions grow; reset only on the "unknown session" retry path.
- **Skills injection symlink machinery** — `ensurePiSkillsInjected`, skill bin PATH wiring (execute.ts:81-131, 327-343). Unless you want employees to have special abilities later; start without.
- **Origin/monitor/routine fields** on tasks, `goals`/`projects` hierarchy, `cost_events` provider/biller/billingType breakdown (`unknown` for local anyway).
- The 11k-line `heartbeat.ts` orchestration, `routines.ts` (8k), all `plugin_*` tables.

**KEEP (the load-bearing core):**
- **Atomic single-assignee checkout** via conditional UPDATE + `run_id` lock (§4). This is the one correctness primitive that matters.
- **Concurrency-capped scheduler** — global cap (Paperclip's `maxConcurrentRuns`) + per-employee single-active (§2).
- **pi-local spawn + JSONL parse** — `--mode json -p`, line-buffered streaming, `parsePiJsonl` (copy nearly verbatim), session resume via `--session` (§3).
- **Adapter callback shape** — `onLog`/`onMeta`/`onSpawn` → activity events → renderer. This streaming contract is clean; keep it.
- **Run lifecycle: pre-lock → execute → derive outcome from exit/timeout/error → finalize status+cost** (heartbeat.ts:8861-8976 spine).
- **Token→cost→meter** — `round(costUsd*100)`, bump denormalized total (§5).
- **activity_log** as the event-sourcing spine — replay to rebuild UI, audit trail, live feed. The autoincrement `id` as global sequence.

---

## My take / friction

- **You're asking the right question** by anchoring on the algorithm not the schema — Paperclip's value is the checkout-lock + adapter-stream patterns, and they're tiny once extracted. The 17k lines of service code is 95% multi-tenant/governance/remote-exec scaffolding you don't have.
- **One thing to reconsider: `blocked` vs `failed`.** I split them (blocked = retryable soft-fail, failed = hard). But pi's `-p` non-interactive mode can't actually *ask* for input mid-run — it just exits. So "blocked" can only mean "the agent's final message said it's stuck." That's a heuristic (`looksBlocked` parsing the summary), which is fuzzy. Cleaner game design: **drop `blocked`, make every non-zero exit `failed`, and let the player re-assign (which routes failed→todo→queued).** One less status, no summary-parsing heuristic. I'd cut it unless "blocked" is a deliberate game mechanic.
- **Sessions are a game mechanic in disguise.** `employee.session_id` resume means an employee accumulates context across tasks — they get "smarter"/cheaper (cache hits) the more they work in one area. That's free emergent progression. Worth surfacing in the UI.
- **The native-module decision is the only one with real downside.** If `electron-rebuild` friction scares you, the honest fallback is `node:sqlite` (accept experimental-API churn) — but **not** JSON stores, which break the concurrency model. Don't compromise the checkout lock to dodge a build-config step.

**Unresolved questions:**
1. Keep `blocked` status, or collapse to `failed` + re-assign? (I lean collapse.)
2. One shared cwd for all employees, or per-employee dir? (Per-employee = isolation + session-cwd-match safety.)
3. Token-price fallback table now, or wait until a model returns `costUsd: 0`?
4. Cancellation policy: `SIGTERM` + grace then `SIGKILL` (Paperclip's `graceSec`), or hard kill immediately?
5. Do employees ever run *unprompted* (idle "they keep working" loop), or strictly player-assigned tasks? Changes whether you need a heartbeat-style poll loop at all.
