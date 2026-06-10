# SPEC: pi-driver-embed

Confirmed. `openai-codex` provider exists (21 refs), `gpt-5.5` exists (12 refs). `APP_NAME` comes from the pi-coding-agent's own `package.json` `piConfig.name` field — so `ENV_AGENT_DIR` is `"PI_CODING_AGENT_DIR"` by default (matches `paths.ts` setting `process.env["PI_CODING_AGENT_DIR"]`).

I now have a complete picture. Here is the spec.

---

# Multi-Agent Pi Driver — Exact Replication Spec

Source: inteligir `@repo/pi-driver` + `apps/desktop/src/agent/*`, pinned to pi `0.73.1`. Verified against installed `.d.ts`/`.js` in `node_modules`.

## 0. Architecture delta vs inteligir

Inteligir runs ONE agent (module-level `let agent: Agent | null`). For per-employee agents you instantiate `PiAgent` N times. The pi SDK supports this — `AgentSession`, `SessionManager`, `ModelRegistry`, `AuthStorage` are all plain classes with NO module-level singleton state holding the "current" session. The only process-global state is: (a) pi-ai's static model `Map`, (b) `process.env[PI_CODING_AGENT_DIR]` read per-call by `getAgentDir()`, (c) `process.cwd()`. None are touched per-instance if you always pass explicit `cwd`/`agentDir`/`authStorage`/`modelRegistry`/`sessionManager` into `createAgentSession` (which inteligir's `PiAgent` does). See §7.

---

## 1. npm deps + versions

Direct (from `packages/pi-driver/package.json`):

```json
"@mariozechner/pi-ai": "^0.73.1",
"@mariozechner/pi-coding-agent": "^0.73.1"
```

Both must be the **same version** (they share `@mariozechner/pi-agent-core` as a transitive peer and pass typed objects between each other). pi-coding-agent pulls in transitively (all `0.73.1`, you do NOT list them but they must resolve consistently):

- `@mariozechner/pi-agent-core` — core `Agent`, `AgentEvent`, `ThinkingLevel`, `AgentMessage`
- `@mariozechner/pi-ai` — models, `complete`, `Model`, `Api`, `ImageContent`
- `@mariozechner/pi-tui` — TUI primitives (only needed at type level for extensions; harmless headless)
- `@modelcontextprotocol/sdk@1.29.0`, `ws@8.21.0`, `zod@4.4.3` (peer-ish — present in the pnpm hash; keep zod 4.x)

For writing tools you also need TypeBox. pi re-exports its TypeBox as `typebox` internally, but inteligir's extensions import from `@sinclair/typebox`:

```json
"@sinclair/typebox": "*"   // Type, Static, Value — used to build tool `parameters`
```

`open` is used only for launching the OAuth URL (`apps/desktop/src/agent/auth.ts`).

Module type: `"type": "module"` (ESM). pi 0.73 is ESM-only.

---

## 2. Construct / start / subscribe / prompt / stop

The whole lifecycle is the inteligir `PiAgent` class (`packages/pi-driver/src/agent.ts`). Reproduce it verbatim — it is the canonical wrapper. Key imports and the exact `start()`:

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { Api, ImageContent, Model } from "@mariozechner/pi-ai";
```

`start()` (exact pattern):

```ts
const modelRegistry = ModelRegistry.create(this.config.authStorage);

const factories =
  typeof this.config.extensionFactories === "function"
    ? await this.config.extensionFactories()
    : this.config.extensionFactories;

const resourceLoader = new DefaultResourceLoader({
  cwd: this.config.cwd,
  agentDir: this.config.agentDir,
  extensionFactories: factories,
});
await resourceLoader.reload(); // REQUIRED before createAgentSession

const { session } = await createAgentSession({
  cwd: this.config.cwd,
  agentDir: this.config.agentDir,
  authStorage: this.config.authStorage,
  modelRegistry,
  resourceLoader,
  model: this.config.model, // Model<Api> from resolveModel()
  thinkingLevel: this.config.thinkingLevel ?? "off",
  sessionManager: this.config.sessionManager,
  settingsManager: SettingsManager.create(this.config.cwd, this.config.agentDir),
});

this.unsubscribe = session.subscribe((event: AgentSessionEvent) => this.handleEvent(event));
this.session = session;
```

`CreateAgentSessionOptions` (full, from `dist/core/sdk.d.ts`): `cwd?`, `agentDir?`, `authStorage?`, `modelRegistry?`, `model?`, `thinkingLevel?` (`ThinkingLevel = "off"|"minimal"|"low"|"medium"|"high"|"xhigh"`), `scopedModels?`, `noTools?: "all"|"builtin"`, `tools?: string[]` (allowlist), `customTools?: ToolDefinition[]` (register tools WITHOUT an extension — simpler than extensions, see §5), `resourceLoader?`, `sessionManager?`, `settingsManager?`, `sessionStartEvent?`. Returns `{ session, extensionsResult, modelFallbackMessage? }`.

Send a prompt (`AgentSession.prompt(text, options?)`):

```ts
// idle → prompt; if streaming you MUST route to followUp/steer or it throws.
void session.prompt(message, images ? { images } : undefined).catch(...);
// while busy:
await session.followUp(message, images);   // queued, runs after current turn
await session.steer(message, images);       // injected mid-turn, before next LLM call
```

`PromptOptions`: `{ images?, expandPromptTemplates?, streamingBehavior?: "steer"|"followUp", source?: "interactive"|"rpc"|"extension" }`. `prompt()` **throws** if `isStreaming` and no `streamingBehavior`, or if no model / no API key. Inteligir guards on its own `status === "busy"` and falls through to `followUp` (race fallback).

Subscribe / unsubscribe:

```ts
const unsub = session.subscribe((event: AgentSessionEvent) => { ... });   // multi-listener
unsub();   // returns per-listener unsubscribe
```

Stop:

```ts
this.unsubscribe?.();
await session.abort(); // aborts current op, waits for idle
session.dispose(); // removes all listeners + disconnects from Agent
this.session = null;
```

Other session methods you'll use: `session.getLastAssistantText()`, `session.getAllTools(): ToolInfo[]`, `session.getActiveToolNames()`, `session.setActiveToolsByName(string[])`, `session.isStreaming`, `session.messages`, `session.sessionId`, `session.sessionFile`, `session.setModel(model)`, `session.setThinkingLevel(level)`.

---

## 3. Event types (for animation mapping)

`session.subscribe` emits `AgentSessionEvent = AgentEvent | <session-extras>`. Raw shapes (from `pi-agent-core/types.d.ts` and `agent-session.d.ts`):

Core `AgentEvent`:
| type | payload | meaning / animation cue |
|---|---|---|
| `agent_start` | `{}` | turn begins → employee "thinking" |
| `agent_end` | `{ messages: AgentMessage[] }` | turn done → return to idle |
| `turn_start` | `{}` | inner loop iteration start |
| `turn_end` | `{ message, toolResults: ToolResultMessage[] }` | iteration done |
| `message_start` | `{ message: AgentMessage }` (`message.role: "assistant"|"user"|"toolResult"`) | start of a bubble |
| `message_update` | `{ message, assistantMessageEvent }` — `assistantMessageEvent.type === "text_delta"` carries `.delta: string` | streaming tokens → typing animation |
| `message_end` | `{ message }` — read `message.role`, `message.content`, `message.stopReason`, `message.errorMessage` | bubble finalized; `stopReason === "error"` = failure |
| `tool_execution_start` | `{ toolCallId, toolName, args }` | tool invoked → tool-specific anim (e.g. "writing code") |
| `tool_execution_update` | `{ toolCallId, toolName, args, partialResult }` | streaming tool output |
| `tool_execution_end` | `{ toolCallId, toolName, result, isError }` | tool done; `result` is content blocks → `extractText` |

Session extras (also delivered to the same subscriber):
| type | payload |
|---|---|
| `queue_update` | `{ steering: readonly string[], followUp: readonly string[] }` |
| `compaction_start` | `{ reason: "manual"|"threshold"|"overflow" }` |
| `compaction_end` | `{ reason, result?, aborted, willRetry, errorMessage? }` |
| `session_info_changed` | `{ name?: string }` |
| `thinking_level_changed` | `{ level: ThinkingLevel }` |
| `auto_retry_start` | `{ attempt, maxAttempts, delayMs, errorMessage }` |
| `auto_retry_end` | `{ success, attempt, finalError? }` |

**Critical gotcha (inteligir-discovered):** `stopReason` and `errorMessage` live on `event.message`, NOT on the event root. Reading them from root silently swallows every provider/auth error. Inteligir's `parseAgentEvent` (`shared/agent-event-parser.ts`) normalizes raw → a flat `AppAgentEvent` and validates shape with TypeBox `Value.Check`. Reproduce that parser; it returns `null` for events you don't care about and never throws. Its flattened union (`shared/agent-events.ts`):

```ts
type AppAgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start"; role: "assistant" | "user" }
  | { type: "message_update"; delta: string }
  | { type: "message_end"; role: string; text: string; stopReason?: string; errorMessage?: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; isError: boolean; resultText: string }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "turn_error"; kind: "auth" | "unknown"; reason: string }; // synthetic, see below
```

**Empty-turn detection** (`app-machine.ts handleAgentEvent`): track per-turn whether you saw any assistant text / tool call / explicit error between `agent_start` and `agent_end`. If `agent_end` fires with none → synthesize a `turn_error` (almost always upstream LLM/auth failure swallowed as success). Worth replicating per employee.

---

## 4. OpenAI auth (`openai-codex` / OAuth / shared creds)

Provider literal: `"openai-codex"`. Default model id: `"gpt-5.5"` (also available: `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.1`, `gpt-5-codex`, etc. — confirmed present in `models.generated.js`).

AuthStorage (`packages/pi-driver/src/auth.ts`):

```ts
import { AuthStorage } from "@mariozechner/pi-coding-agent";
const authStorage = AuthStorage.create(authPath); // authPath = ~/.inteligir/auth.json (you: your app dir)
authStorage.hasAuth("openai-codex"); // bool, no token refresh
await authStorage.login("openai-codex", {
  // OAuth round-trip, persists creds
  onAuth: (info) => open(info.url), // open the URL for the user
  onPrompt: () => Promise.reject(new Error("Interactive prompt not supported")),
});
```

Creds persist to the `authPath` file as `Record<provider, AuthCredential>` where `AuthCredential = {type:"api_key",key} | {type:"oauth", ...OAuthCredentials}`. `getApiKey()` priority: runtime override → api_key → OAuth token (auto-refreshed) → env var → fallback resolver.

**Can multiple agents share one AuthStorage? YES — and you SHOULD.** Build ONE `AuthStorage` per process and inject it into every `PiAgent`. `FileAuthStorageBackend` uses **file locking** (`withLock`/`acquireLockSyncWithRetry`) specifically so concurrent instances can refresh OAuth tokens without corrupting `auth.json` (docstring: "Uses file locking to prevent race conditions when multiple pi instances try to refresh tokens simultaneously"). Inteligir caches a single lazy instance (`agent/auth.ts getAuthStorage()`) and resets it on logout. For multi-agent: one shared instance is correct and avoids N concurrent token refreshes — though even N separate instances over the same file are safe due to the lock.

Model resolution (`packages/pi-driver/src/model.ts`):

```ts
import { getModels } from "@mariozechner/pi-ai";
export function resolveModel(provider, modelId): Model<Api> {
  const model = getModels(provider).find((m) => m.id === modelId);
  if (!model) throw new Error(`Model "${provider}/${modelId}" not found`);
  return model;
}
// resolveModel("openai-codex", "gpt-5.5")
```

`getModels` reads pi-ai's static in-memory `Map` (built from `models.generated.js` at module load) — cheap, synchronous, no I/O. `ModelRegistry.create(authStorage)` wraps it + reads optional `models.json` for custom models and does API-key resolution. The resolved `Model<Api>` is immutable data — **safe to share the same `Model` object across all agents**.

One-shot completion outside a session (inteligir `complete.ts`, useful for cheap NPC chatter without a turn): `ModelRegistry.getApiKeyAndHeaders(model)` → `complete(model, {systemPrompt, messages}, {apiKey, headers})` from pi-ai. It `WeakMap`-caches one `ModelRegistry` per `AuthStorage`.

---

## 5. Custom tools / extensions

Two ways. For game-specific tools, the **simpler** path is `customTools` on `createAgentSession` (no extension factory needed). The inteligir path is the `PiExtensionBundle` → `ExtensionFactory` pattern, which you need only if your tool also subscribes to lifecycle events (e.g. `before_agent_start`).

### A. Simplest: a `ToolDefinition` via `customTools`

```ts
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const moveSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
}); // MUST be Type.Object at root — providers reject anyOf/allOf (Union/Intersect). See validation below.

const moveTool: ToolDefinition<typeof moveSchema> = {
  name: "move_to",
  label: "move_to",
  description: "Move the employee to a tile.",
  parameters: moveSchema,
  execute: async (toolCallId, params: Static<typeof moveSchema>, signal, onUpdate, ctx) => {
    game.move(params.x, params.y);
    return { content: [{ type: "text", text: `Moved to ${params.x},${params.y}` }], details: {} };
  },
};
// pass via createAgentSession({ ..., customTools: [moveTool] })
```

`execute` signature (exact): `(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback | undefined, ctx: ExtensionContext) => Promise<AgentToolResult>`. Return shape: `{ content: [{type:"text", text}], details }`. Inteligir's `textResult()` helper: `{ content: [{ type: "text", text: value }], details: {} }`.

### B. Inteligir's `PiExtensionBundle` (tool + event hooks)

`ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`. Minimal:

```ts
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

const gameExtension: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "move_to",
    label: "move_to",
    description: "...",
    parameters: moveSchema,
    execute: async (_id, params: Static<typeof moveSchema>) => textResult("ok"),
  });
  pi.on("before_agent_start", (_e, _ctx) => {
    pi.sendMessage({ customType: "world-state", content: `[World] ${describe()}`, display: false });
  });
};
// register via DefaultResourceLoader({ extensionFactories: [gameExtension] })  ← what start() does
```

`ExtensionAPI` highlights: `registerTool`, `on(event, handler)` (all event types in §3 plus `before_agent_start`, `tool_call`/`tool_result` for blocking/mutating, `session_start`, `session_shutdown`), `sendMessage` (inject hidden context), `sendUserMessage`, `registerProvider`/`unregisterProvider`, `setModel`, `getAllTools`, `events: EventBus`.

Inteligir wraps each factory with **schema validation** (`agent/extension.ts buildValidatedFactories` + `wrapPiWithSchemaValidation`): a `Proxy` intercepts `registerTool` and asserts `parameters.type === "object"` before registration. **Keep this** — TypeBox `Union`/`Intersect` emit `anyOf`/`allOf` with no root `type`, which OpenAI silently rejects every turn (→ empty turns). Model discriminated unions as `Type.Object({ action: Type.Union([Type.Literal(...)]) })` and validate per-case at runtime (see `tasks/extension.ts`).

Bundle auto-discovery (optional): inteligir globs `./*/extension.ts` default exports via Vite `import.meta.glob`. For per-employee tools you'll more likely build factories dynamically per employee (closure over that employee's game state) and pass them to that agent's `extensionFactories`.

---

## 6. Session persistence (per-employee sessions)

`SessionManager` stores conversations as append-only JSONL trees. Constructors (all static, from `dist/core/session-manager.d.ts`):

```ts
SessionManager.create(cwd, sessionDir?)          // fresh session, new id
SessionManager.continueRecent(cwd, sessionDir?)  // resume most recent in sessionDir, else create
SessionManager.open(filePath, sessionDir?, cwdOverride?)  // resume a specific file
SessionManager.inMemory(cwd?)                    // no persistence
SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)
SessionManager.list(cwd, sessionDir?)            // Promise<SessionInfo[]>
SessionManager.listAll()
```

Default storage: `~/.pi/agent/sessions/<encoded-cwd>/` (overridden by env, see §7). Inteligir overrides to `~/.inteligir/sessions` via the `sessionDir` arg and resolves which session in `agent/agent.ts resolveSessionManager()`:

```ts
const sessionFile = process.env["INTELIGIR_SESSION_FILE"];
if (sessionFile) return SessionManager.open(sessionFile, SESSION_DIR);
return SessionManager.continueRecent(WORKSPACE_DIR, SESSION_DIR);
// "new session" path: SessionManager.create(WORKSPACE_DIR, SESSION_DIR)
```

**Per-employee sessions** — two viable strategies:

1. **Per-employee `sessionDir`** (cleanest isolation): give each employee its own directory, e.g. `~/<app>/employees/<employeeId>/sessions`, and use `continueRecent(employeeCwd, employeeSessionDir)`. Resume is automatic (most-recent in that dir).
2. **Per-employee file**: store the chosen `sessionFile` path per employee (persist it yourself), `SessionManager.open(file, sharedSessionDir)` to resume, `SessionManager.create(cwd, dir)` for a brand-new one.

The `cwd` is stored in the session header and used for `<encoded-cwd>` dir naming — give each employee a distinct `cwd` (even a synthetic per-employee workspace dir) so default-dir derivation and any project-scoped discovery (`<cwd>/.pi/skills`) don't collide. To resume: persist `getSessionFile()` (or just rely on `continueRecent` against the employee's dir). Each `PiAgent` owns its own `SessionManager` instance — never share one across agents (it tracks a single mutable leaf pointer).

---

## 7. Multiple concurrent `PiAgent` in one Electron main process — gotchas

The big one. The pi SDK is instance-based, so concurrency is safe **iff** you always inject explicit per-instance objects. Specifics:

1. **pi-ai model registry is a process-global `Map`** (`modelRegistry` in `models.js`, built from `models.generated.js` at import). `getModels`/`getModel` read it. `ExtensionAPI.registerProvider` / `ModelRegistry.registerProvider` **mutate global model state**. → Do NOT call `registerProvider`/`unregisterProvider` from per-employee extensions if employees could register conflicting providers. Built-in `openai-codex` models are immutable & shared — fine. If you need custom providers, register once at startup, not per-agent.

2. **`getAgentDir()` reads `process.env[PI_CODING_AGENT_DIR]` per call** (env var name = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`; `APP_NAME` comes from pi-coding-agent's own `package.json piConfig.name`, default `"pi"` → `PI_CODING_AGENT_DIR`; `ENV_SESSION_DIR = PI_CODING_AGENT_SESSION_DIR`). This is a **process global**. Inteligir sets it once at startup (`paths.ts configurePaths()`). → Set it ONCE before any agent starts; do NOT mutate it per employee. To isolate per-employee state, pass explicit `agentDir`/`cwd`/`sessionManager` into `createAgentSession` (which `PiAgent` does) — those override defaults and bypass the global. The global only matters for code paths that call `getAgentDir()` directly (e.g. `loadSkills` defaults, `ModelRegistry.create` default modelsJson path). Since you inject `modelRegistry` and `resourceLoader` explicitly, the global agentDir is effectively only the fallback.

3. **`process.cwd()`** — pi defaults `cwd` to `process.cwd()`. **Always pass an explicit `cwd`** per agent (you already do). Never `process.chdir()` to switch employees — it's process-global and would corrupt other agents' relative-path tools (bash/read/edit/write all resolve against the agent's `cwd`).

4. **Share ONE `AuthStorage`** across all agents (file-locked refresh; §4). Build it once, inject into every `PiAgent`. Avoids N simultaneous OAuth refreshes hammering the token endpoint. On logout/reauth, rebuild the single instance and restart all agents (inteligir resets + restarts; you'd iterate your employee map).

5. **`ModelRegistry`** — inteligir creates one per agent (`ModelRegistry.create(authStorage)` in `start()`). That's fine (cheap, reads static models). For many agents, prefer **one shared `ModelRegistry`** built over the shared `AuthStorage` (mirror `complete.ts`'s `WeakMap` cache) to avoid re-reading `models.json` N times. Inject it as `modelRegistry`. Don't call `registerProvider` on it per-agent (see #1).

6. **`SettingsManager.create(cwd, agentDir)`** reads/writes `settings.json` under agentDir. If all employees share one agentDir, they share settings (model/thinking defaults, steering mode) and concurrent writes can race. Give each employee a distinct `agentDir` (or distinct settings location), OR accept shared read-only settings and never call setters (`setModel`/`setThinkingLevel`/`setSteeringMode`) that persist. Per-employee `agentDir` also cleanly isolates skills (`<agentDir>/skills`) and `AGENTS.md`.

7. **`SessionManager` is per-agent, never shared** (single mutable leaf pointer). One per employee (§6).

8. **`resourceLoader.reload()` must be awaited before `createAgentSession`** for each agent (loads that agent's skills/prompts/extensions). Each agent gets its own `DefaultResourceLoader` bound to its `cwd`/`agentDir`/`extensionFactories`.

9. **Event-listener isolation**: each `AgentSession` has its own listener set; `subscribe` returns a per-listener unsub. Inteligir's `PiAgent.handleEvent` swallows listener exceptions so one bad listener can't break sibling agents — keep that.

10. **Teardown order**: `unsubscribe()` → `await session.abort()` → `session.dispose()`. Abort first so in-flight provider streams stop before dispose. Per employee on despawn.

### Recommended shared-vs-per-agent split

| Object                                                                                                                | Scope                                                |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `AuthStorage`                                                                                                         | **shared** (one per process, file-locked)            |
| `ModelRegistry`                                                                                                       | **shared** (one over the shared AuthStorage)         |
| `Model<Api>` (resolveModel result)                                                                                    | **shared** (immutable)                               |
| `process.env[PI_CODING_AGENT_DIR]`, cwd                                                                               | **process-global**, set once, never mutate per-agent |
| `cwd`, `agentDir`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, `AgentSession`, `extensionFactories` | **per employee**                                     |

---

### Minimal multi-agent driver skeleton (assembled from the verified APIs)

```ts
// once at process startup:
process.env["PI_CODING_AGENT_DIR"] = APP_AGENT_DIR; // global fallback only
const authStorage = AuthStorage.create(path.join(APP_AGENT_DIR, "auth.json"));
const modelRegistry = ModelRegistry.create(authStorage);
const model = resolveModel("openai-codex", "gpt-5.5");

// per employee:
async function spawnEmployee(id: string, gameState: EmployeeState) {
  const cwd = path.join(APP_AGENT_DIR, "employees", id, "workspace");
  const agentDir = path.join(APP_AGENT_DIR, "employees", id); // isolates settings+skills
  const sessionDir = path.join(agentDir, "sessions");
  fs.mkdirSync(cwd, { recursive: true });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [buildEmployeeExtension(id, gameState)], // closure over this employee
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader,
    model,
    thinkingLevel: "off",
    sessionManager: SessionManager.continueRecent(cwd, sessionDir), // resume-or-new per employee
    settingsManager: SettingsManager.create(cwd, agentDir),
  });

  const unsub = session.subscribe((raw) => {
    const ev = parseAgentEvent(raw); // inteligir's flattening parser
    if (ev) onEmployeeEvent(id, ev); // → game animation
  });
  return { session, unsub };
}
```

---

## Friction / what I'd change

- The pi-ai global model `Map` + per-call `getAgentDir()` env read are the only real multi-agent hazards. Wrap them: never let an extension call `registerProvider`, and treat `PI_CODING_AGENT_DIR`/`cwd` as immutable after boot. Everything else is cleanly instance-scoped.
- Inteligir's `PiAgent` is essentially copy-pasteable. The pieces worth lifting wholesale: the `prompt`-vs-`followUp` busy-race fallback, the `subscribe-before-status-check` in `waitForIdle`, the schema-validation `Proxy`, and the empty-turn `turn_error` synth. These are battle-tested error paths you'd otherwise rediscover.
- Open question for your design: do employees share one `agentDir` (shared skills/AGENTS.md, simpler, but shared+racy settings) or one each (full isolation, more disk + you re-seed skills N times)? I'd default to per-employee `agentDir` and seed skills via symlink to a shared read-only skills dir to avoid duplication.
- `pi-ai`/`pi-coding-agent`/`pi-agent-core` versions MUST be locked in lockstep (`0.73.1`). A minor mismatch silently breaks the typed objects passed between `createAgentSession` and pi-ai.

Relevant source files: `/Users/kyh/Documents/Projects/inteligir/packages/pi-driver/src/{agent,auth,model,complete,skills,pi-types}.ts`, `/Users/kyh/Documents/Projects/inteligir/apps/desktop/src/agent/{agent,setup,auth,paths,extension,extension-helpers}.ts`, `/Users/kyh/Documents/Projects/inteligir/apps/desktop/src/agent/tasks/extension.ts`, `/Users/kyh/Documents/Projects/inteligir/apps/desktop/src/main/app-machine.ts`, `/Users/kyh/Documents/Projects/inteligir/apps/desktop/src/shared/{agent-events,agent-event-parser}.ts`. There is NO `src/index.ts` — the package exports via `"./*": "./src/*.ts"` subpath mapping.
