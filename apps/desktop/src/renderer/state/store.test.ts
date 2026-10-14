import { setImmediate as settle } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@repo/domain/activity";
import type {
  AgentRunner,
  AuthFlowEvent,
  Company,
  Employee,
  RestingRunners,
  TeamMessage,
} from "@repo/domain/domain";
import type { PageEvent, PageEvents } from "@repo/contract/events";
import type { Api, Listen } from "@/renderer/api";
import type { Office } from "@/renderer/game/office-port";
import { feedKey } from "@/renderer/state/activity-reducer";

const company: Company = {
  autopilot: true,
  budget: { mode: "infinite" },
  businessType: "software",
  createdAt: 0,
  founderName: "Kai",
  founderSpriteSeed: "kai",
  id: "co",
  leaderId: "lead",
  maxAgents: 4,
  mission: "",
  name: "Co",
  revenueUsd: null,
  ships: 0,
  spentUsd: 0,
  users: null,
  workspaceDir: "/tmp/co",
};

const employee = (id: string, status: Employee["status"] = "idle"): Employee => ({
  companyId: "co",
  createdAt: 0,
  deskIndex: 0,
  id,
  instructionsDigest: null,
  lastRunMetrics: null,
  lastShip: null,
  name: id,
  persona: "",
  role: "engineer",
  runner: "claude",
  session: null,
  spriteSeed: id,
  status,
  title: "Engineer",
});

const stamp = { createdAt: 0, id: 1, runId: "r1", taskId: "t1" };
const started = (employeeId: string): ActivityEvent => ({
  ...stamp,
  employeeId,
  kind: "run.start",
});
const napping = (runner: "claude" | "codex", until: number): ActivityEvent => ({
  ...stamp,
  employeeId: "lead",
  kind: "runner.resting",
  payload: { cause: "usage-limit", error: "You've hit your limit", runner, until },
});
const refused = (employeeId: string): ActivityEvent => ({
  ...stamp,
  employeeId,
  kind: "run.end",
  payload: {
    outcome: { error: "Failed to authenticate", kind: "signedOut" },
    settled: "queued",
    summary: "",
  },
});
const hired = (employeeId: string): ActivityEvent => ({
  createdAt: 0,
  employeeId,
  id: 1,
  kind: "org.hired",
  payload: { by: "lead", name: employeeId, title: "Engineer" },
});

/** The chat event of room line `id`, said at `id`. */
const said = (id: number, text: string): ActivityEvent => ({
  createdAt: id,
  employeeId: null,
  id: 100 + id,
  kind: "chat",
  message: text,
  payload: { from: { kind: "founder" }, line: id, to: null },
});

/** What these tests let main answer late. */
type Late = "employees.list" | "agents.resting";

/** Who hears each of the server's events. */
type Listeners = { [E in PageEvent]: Set<(data: PageEvents[E]) => void> };

/** The procedures these tests let the store call. */
interface FakeApi {
  agents: Pick<Api["agents"], "hasAuth" | "resting">;
  bets: Pick<Api["bets"], "list">;
  company: Pick<Api["company"], "get" | "setMaxAgents">;
  employees: Pick<Api["employees"], "list">;
  products: Pick<Api["products"], "list">;
  save: Pick<Api["save"], "report">;
  stripe: Pick<Api["stripe"], "keyStatus" | "status">;
  tasks: Pick<Api["tasks"], "list">;
  team: Pick<Api["team"], "messages">;
}

interface MainHolds {
  authed: boolean;
  signedOut: AgentRunner[];
  employees: Employee[];
  resting: RestingRunners;
  room: TeamMessage[];
}

/**
 * Main as the page's API hands it over: a `late` procedure answers only when the
 * test says, with what main held when it was asked; the rest answer at once.
 */
const fakeMain = (late: readonly Late[]) => {
  const main: MainHolds = {
    authed: true,
    employees: [employee("lead")],
    resting: {},
    room: [],
    signedOut: [],
  };
  const waiting: { method: Late; release: () => void }[] = [];
  const listeners: Listeners = {
    activity: new Set(),
    auth: new Set(),
    stripe: new Set(),
  };
  const listen: Listen = (event, listener) => {
    listeners[event].add(listener);
    return () => listeners[event].delete(listener);
  };
  const answerOf = <T>(method: Late, value: T): Promise<T> => {
    if (!late.includes(method)) {
      return Promise.resolve(value);
    }
    const answer = Promise.withResolvers<T>();
    waiting.push({ method, release: () => answer.resolve(value) });
    return answer.promise;
  };
  const api: FakeApi = {
    agents: {
      hasAuth: () => Promise.resolve({ ok: main.authed, signedOut: main.signedOut }),
      resting: () => answerOf("agents.resting", main.resting),
    },
    bets: { list: () => Promise.resolve([]) },
    company: {
      get: () => Promise.resolve(company),
      setMaxAgents: ({ maxAgents }) => Promise.resolve({ ...company, maxAgents }),
    },
    employees: { list: () => answerOf("employees.list", main.employees) },
    products: { list: () => Promise.resolve([]) },
    save: { report: () => Promise.resolve({ companies: 1, skipped: [] }) },
    stripe: {
      keyStatus: () => Promise.resolve({ state: "unset" }),
      status: () => Promise.resolve({ state: "disconnected" }),
    },
    tasks: { list: () => Promise.resolve([]) },
    team: { messages: ({ limit = 30 }) => Promise.resolve(main.room.slice(-limit)) },
  };
  return {
    /** Answer the oldest request for `method` still waiting. */
    answer: async (method: Late): Promise<void> => {
      const at = waiting.findIndex((call) => call.method === method);
      const [call] = at === -1 ? [] : waiting.splice(at, 1);
      if (!call) {
        throw new Error(`nothing is waiting on ${method}`);
      }
      call.release();
      await settle();
    },
    api,
    emit: async (e: ActivityEvent): Promise<void> => {
      for (const listener of listeners.activity) {
        listener(e);
      }
      await settle();
    },
    listen,
    /** A step of a login the founder started. */
    login: async (e: AuthFlowEvent): Promise<void> => {
      for (const listener of listeners.auth) {
        listener(e);
      }
      await settle();
    },
    main,
  };
};

/** An office that only records what it is told. */
const fakeOffice = () => {
  const told: { message: string; payload: unknown }[] = [];
  const game: Office = {
    events: {
      emit: (message, payload) => told.push({ message, payload }),
      off: () => {},
      on: () => {},
    },
  };
  const walkedIn = (): unknown[] =>
    told.filter((m) => m.message === "spawn-employee").map((m) => m.payload);
  return { game, walkedIn };
};

const freshStore = async ({ api, listen }: { api: FakeApi; listen: Listen }) => {
  vi.stubGlobal("appApi", { api, listen });
  vi.resetModules();
  const store = await import("@/renderer/state/store");
  store.initStore();
  await settle();
  return store;
};

type Store = Awaited<ReturnType<typeof freshStore>>;
type Seen = Parameters<Parameters<Store["useStore"]>[0]>[0];

const Probe = ({ select, store }: { select: (s: Seen) => string; store: Store }): string =>
  store.useStore(select);

const Screen = ({ store }: { store: Store }): string => store.useBoot().kind;
const screen = (store: Store): string => renderToStaticMarkup(createElement(Screen, { store }));

/** What a component reading the store would show. */
const read = (store: Store, select: (s: Seen) => string): string =>
  renderToStaticMarkup(createElement(Probe, { select, store }));

const feed = (s: Seen): string => s.feed.map(feedKey).join(" ");
const roster = (s: Seen): string => s.employees.map((e) => `${e.id}:${e.status}`).join(" ");
const boot = (s: Seen): string => `${s.booted} ${s.bootFailure ?? "-"}`;
const signedOut = (s: Seen): string => s.signedOut.join(" ");
const resting = (s: Seen): string =>
  Object.entries(s.resting)
    .map(([runner, until]) => `${runner}:${until}`)
    .toSorted()
    .join(" ");

describe("store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens #team on the room main kept, and shows each line it then hears once", async () => {
    const { api, listen, emit, main } = fakeMain([]);
    main.room = [
      { companyId: "co", createdAt: 1, from: { kind: "founder" }, id: 1, text: "early" },
    ];
    const store = await freshStore({ api, listen });
    expect(read(store, feed)).toBe("room 1");
    await emit(said(1, "early"));
    await emit(said(2, "later"));
    expect(read(store, feed)).toBe("room 1 room 2");
  });

  it("keeps a run that starts during the first refresh, and the roster that refresh went for", async () => {
    const { answer, api, listen, emit, main } = fakeMain(["employees.list"]);
    const store = await freshStore({ api, listen });
    main.employees = [employee("lead", "working")];
    await emit(started("lead"));
    // asked before the run started, so refused
    await answer("employees.list");
    // the refresh, run once more
    await answer("employees.list");
    expect(read(store, roster)).toBe("lead:working");
  });

  it("keeps the other runner's rest when one lands during the first refresh", async () => {
    const { answer, api, listen, emit, main } = fakeMain(["agents.resting"]);
    main.resting = { codex: 9 };
    const store = await freshStore({ api, listen });
    main.resting = { claude: 5, codex: 9 };
    await emit(napping("claude", 5));
    await answer("agents.resting");
    await answer("agents.resting");
    expect(read(store, resting)).toBe("claude:5 codex:9");
  });

  it("keeps an employee working when a refresh asked for before their run started lands after it", async () => {
    const { answer, api, listen, emit, main } = fakeMain(["employees.list"]);
    const store = await freshStore({ api, listen });
    await answer("employees.list");
    expect(read(store, roster)).toBe("lead:idle");

    const refreshed = store.refresh();
    await settle();
    main.employees = [employee("lead", "working")];
    await emit(started("lead"));
    await answer("employees.list");
    await refreshed;
    expect(read(store, roster)).toBe("lead:working");
    await answer("employees.list");
    expect(read(store, roster)).toBe("lead:working");
  });

  it("keeps a cap the founder saved while a refresh that read the company earlier is in flight", async () => {
    const { answer, api, listen } = fakeMain(["employees.list"]);
    const store = await freshStore({ api, listen });
    await answer("employees.list");

    const refreshed = store.refresh();
    await settle();
    await store.setMaxAgents(6);
    expect(read(store, (s) => String(s.company?.maxAgents))).toBe("6");
    await answer("employees.list");
    await refreshed;
    expect(read(store, (s) => String(s.company?.maxAgents))).toBe("6");
  });

  it("walks a hire in when a run's patch refused the refresh that found them", async () => {
    const { answer, api, listen, emit, main } = fakeMain(["employees.list"]);
    const store = await freshStore({ api, listen });
    await answer("employees.list");
    const { game, walkedIn } = fakeOffice();
    store.setGame(game);

    main.employees = [employee("lead"), employee("mae")];
    await emit(hired("mae"));
    main.employees = [employee("lead", "working"), employee("mae")];
    await emit(started("lead"));
    // the hire's refresh, refused: the run's patch is newer
    await answer("employees.list");
    expect(read(store, roster)).toBe("lead:working");
    // what the patch asked for again, then the hire looked up
    await answer("employees.list");
    await answer("employees.list");
    expect(walkedIn()).toEqual([employee("mae")]);
    expect(read(store, roster)).toBe("lead:working mae:idle");
  });

  it("logs an event it could not apply, never leaving its failure unhandled", async () => {
    const { api, listen, emit, main } = fakeMain([]);
    const store = await freshStore({ api, listen });
    const fault = new Error("the scene is gone");
    store.setGame({
      events: {
        emit: (message) => {
          if (message === "spawn-employee") {
            throw fault;
          }
        },
        off: () => {},
        on: () => {},
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      main.employees = [employee("lead"), employee("mae")];
      await emit(hired("mae"));
      expect(logged).toHaveBeenCalledWith("Could not apply an activity event", fault);
    } finally {
      logged.mockRestore();
    }
  });

  it("opens the office once a login finishes, though the launch probe found no CLI", async () => {
    const { api, listen, login, main } = fakeMain([]);
    main.authed = false;
    const store = await freshStore({ api, listen });
    expect(screen(store)).toBe("signed-out");
    await login({ message: "No signed-in coding CLI yet.", type: "error" });
    expect(screen(store)).toBe("signed-out");
    main.authed = true;
    await login({ type: "done" });
    expect(screen(store)).toBe("office");
  });

  it("names a runner a turn found refused while another is still signed in, until a sign-in clears it", async () => {
    const { api, listen, emit, login, main } = fakeMain([]);
    const store = await freshStore({ api, listen });
    main.signedOut = ["codex"];
    await emit(refused("lead"));
    expect(screen(store)).toBe("office");
    expect(read(store, signedOut)).toBe("codex");
    await login({ type: "done" });
    expect(read(store, signedOut)).toBe("codex");
    main.signedOut = [];
    await login({ type: "done" });
    expect(read(store, signedOut)).toBe("");
  });

  it("says why the first refresh failed until a retry lands", async () => {
    const { api, listen } = fakeMain([]);
    let asked = 0;
    const store = await freshStore({
      api: {
        ...api,
        company: {
          ...api.company,
          get: () => {
            asked += 1;
            return asked === 1 ? Promise.reject(new Error("main went away")) : api.company.get();
          },
        },
      },
      listen,
    });
    expect(read(store, boot)).toBe("false main went away");
    await store.refresh();
    expect(read(store, boot)).toBe("true -");
  });
});
