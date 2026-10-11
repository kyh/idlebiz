import { useMemo, useSyncExternalStore } from "react";
import type { QueryKey } from "@tanstack/react-query";
import type { ActivityEvent } from "@repo/domain/activity";
import type {
  ActionReply,
  AuthFlowEvent,
  Budget,
  Company,
  Employee,
  Task,
} from "@repo/domain/domain";
import type { Digest } from "@repo/domain/digest";
import { api, orpc } from "@/renderer/api";
import { hearMain, listen } from "@/renderer/page-events";
import { hear, tell } from "@/renderer/game/office-port";
import type { Office } from "@/renderer/game/office-port";
import { EVERYTHING, joinFeed, reduceActivity, roomLines } from "@/renderer/state/activity-reducer";
import type { FeedLine } from "@/renderer/state/activity-reducer";
import {
  BOOT_QUERIES,
  authQuery,
  companyQuery,
  employeesQuery,
  held,
  openTasksQuery,
  patchAnswer,
  queryClient,
  read,
  restingQuery,
  setAnswer,
  stripeKeyQuery,
  useRoom,
  warm,
} from "@/renderer/state/queries";

// What the window holds of its own: what it heard of main's events, and where the founder is in
// it. Main's state is in the query cache (queries.ts); this applies main's events to it.

interface State {
  /** Main's events as heard, the newest last, to the last few hundred. */
  activity: ActivityEvent[];
  /** The #team lines heard since the window opened; the room main keeps joins them as it shows. */
  feed: FeedLine[];
  game: Office | null;
  /** A dialogue/modal overlay is up (ambient HUD chrome hides). */
  modalOpen: boolean;
  /** The employee the founder is talking to, from the office or the roster. */
  talkingTo: string | null;
}

let state: State = {
  activity: [],
  feed: [],
  game: null,
  modalOpen: false,
  talkingTo: null,
};
const listeners = new Set<() => void>();

const set = (patch: Partial<State>): void => {
  state = { ...state, ...patch };
  for (const l of listeners) {
    l();
  }
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Subscribe to one value in the store. The component re-renders only when it
 * changes — so select a field, not a fresh object.
 */
export const useStore = <T>(selector: (s: State) => T): T => {
  const select = (): T => selector(state);
  return useSyncExternalStore(subscribe, select, select);
};

/** What #team shows, newest last: the room as main keeps it, and the news heard since the window opened. */
export const useFeed = (): FeedLine[] => {
  const heard = useStore((s) => s.feed);
  const { messages } = useRoom();
  return useMemo(() => joinFeed(heard, roomLines(messages)), [heard, messages]);
};

// Scene startup can finish after an overlay mounted; replay the current keyboard state.
const syncModal = (): void => {
  if (state.game) {
    tell(state.game, "ui-modal", state.modalOpen);
  }
};

let stopHearingInputReady: (() => void) | null = null;

export const setGame = (game: Office | null): void => {
  stopHearingInputReady?.();
  set({ game });
  stopHearingInputReady = game ? hear(game, "office-input-ready", syncModal) : null;
  syncModal();
};

export const setTalkingTo = (employeeId: string | null): void => {
  set({ talkingTo: employeeId });
};

/** Toggle Phaser keyboard so typing in overlays doesn't move the player. */
export const setModalOpen = (open: boolean): void => {
  set({ modalOpen: open });
  syncModal();
};

/** Ask main again for what the window waits on to open, failing as the first of those reads fails. */
export const refresh = async (): Promise<void> => {
  await Promise.all(
    BOOT_QUERIES.map(({ queryKey }) =>
      queryClient.refetchQueries({ queryKey }, { throwOnError: true }),
    ),
  );
};

/**
 * A company was just founded: its team and their work are read, then the company, so the window
 * opens on all of them at once, and the office rebuilds around the same answers.
 */
export const companyFounded = async (): Promise<void> => {
  await Promise.all([
    read({ ...employeesQuery, staleTime: 0 }),
    read({ ...openTasksQuery, staleTime: 0 }),
  ]);
  await read({ ...companyQuery, staleTime: 0 });
  if (state.game) {
    tell(state.game, "company-ready", null);
  }
};

// ---- actions ---------------------------------------------------------------

const withCompany = async (act: () => Promise<void>): Promise<void> => {
  if (held(companyQuery)) {
    await act();
  }
};
// main answers a change with the company after it, newer than any read asked for before it
const updateCompany = (call: () => Promise<Company>): Promise<void> =>
  withCompany(async () => {
    await setAnswer(companyQuery.queryKey, await call());
  });

const productsMoved = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: orpc.products.key() });
};

// main answers both with `bet.changed` / `product.killed`, and those events refetch what moved
export const killBet = async (betId: string, reason: string): Promise<void> => {
  await api.bets.kill({ betId, reason });
};

export const killProduct = async (productId: string, reason: string): Promise<void> => {
  await api.products.kill({ productId, reason });
};

export const createProduct = (name: string, description: string): Promise<void> =>
  withCompany(async () => {
    await api.products.create({ description, name });
    await productsMoved();
  });

export const setAutopilot = (running: boolean): Promise<void> =>
  updateCompany(() => api.company.setAutopilot({ running }));

export const setBudget = (budget: Budget): Promise<void> =>
  updateCompany(() => api.company.setBudget({ budget }));

export const resetSpend = (): Promise<void> => updateCompany(() => api.company.resetSpend());

/** What happened since the founder last looked; asking is the look. */
export const digest = (): Promise<Digest | null> =>
  held(companyQuery) ? api.company.takeDigest() : Promise.resolve(null);

export const setMaxAgents = (maxAgents: number): Promise<void> =>
  updateCompany(() => api.company.setMaxAgents({ maxAgents }));

const stripeKeyMoved = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: stripeKeyQuery.queryKey });
};

export const saveStripeKey = async (key: string): Promise<void> => {
  await api.stripe.saveKey({ key });
  await stripeKeyMoved();
};

export const removeStripeKey = async (): Promise<void> => {
  await api.stripe.removeKey();
  await stripeKeyMoved();
};

export const connectVercel = async (input: {
  productId: string;
  /** Absent: keep the saved token. */
  token?: string;
  projectId: string;
  projectName: string;
  teamId?: string;
}): Promise<void> => {
  await api.vercel.connect(input);
  await productsMoved();
};

export const disconnectVercel = async (productId: string): Promise<void> => {
  await api.vercel.disconnect({ productId });
  await productsMoved();
};

export const directEmployee = async (employeeId: string, instruction: string): Promise<void> => {
  const text = instruction.trim();
  if (!text) {
    return;
  }
  await api.employees.direct({ employeeId, instruction: text });
};

/** Founder posts in the team channel; @first-name wakes that employee. */
export const sendFounderChat = (text: string): Promise<void> =>
  withCompany(async () => {
    if (text.trim()) {
      await api.team.post({ text: text.trim() });
    }
  });

/** Founder decides on a held outward-facing command; the task resumes either way. */
export const resolveApproval = async (taskId: string, approved: boolean): Promise<void> => {
  await api.tasks.resolveApproval({ approved, taskId });
};

/** Founder took, or could not take, a step only they could; the task resumes either way. */
export const resolveAction = async (taskId: string, reply: ActionReply): Promise<void> => {
  await api.tasks.resolveAction({ reply, taskId });
};

export const copyText = async (text: string): Promise<void> => {
  await api.app.copyText({ text });
};

/** Revive a dead-lettered / failed task: re-assign it (the claim resets retries). */
export const retryTask = async (task: Task): Promise<void> => {
  if (!task.assigneeId) {
    return;
  }
  await api.tasks.assign({ employeeId: task.assigneeId, taskId: task.id });
};

export const answerQuestion = async (taskId: string, answer: string): Promise<void> => {
  await api.tasks.answer({ answer, taskId });
};

// ---- activity --------------------------------------------------------------

// The roster can lack a hire even after the refetch their event asked for: a
// patch that landed meanwhile cancelled that refetch.
const findHire = async (employeeId: string): Promise<Employee | undefined> => {
  const isHire = (emp: Employee): boolean => emp.id === employeeId;
  const found = held(employeesQuery)?.find(isHire);
  if (found) {
    return found;
  }
  try {
    const roster = await read({ ...employeesQuery, staleTime: 0 });
    return roster.find(isHire);
  } catch {
    // they appear in the office when it next boots
    return undefined;
  }
};

// Surgical: the one employee walks in or out, no scene rebuild.
const walkThroughDoor = async (roster: { employeeId: string; hired: boolean }): Promise<void> => {
  if (!state.game) {
    return;
  }
  if (!roster.hired) {
    tell(state.game, "despawn-employee", roster.employeeId);
    return;
  }
  const hire = await findHire(roster.employeeId);
  // the office may have been torn down while main answered
  const { game } = state;
  if (hire && game) {
    tell(game, "spawn-employee", hire);
  }
};

const refetch = async (queryKeys: readonly QueryKey[]): Promise<void> => {
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
};

const onActivity = async (e: ActivityEvent): Promise<void> => {
  const step = reduceActivity(state, e);
  set(step.heard);
  // the event is newer than any answer still in flight, which must not undo it
  if (step.patch.employees) {
    await patchAnswer(employeesQuery.queryKey, step.patch.employees);
  }
  if (step.patch.resting) {
    await patchAnswer(restingQuery.queryKey, step.patch.resting);
  }
  await refetch(step.refetch);
  if (step.recheckAuth) {
    await refetch([authQuery.queryKey]);
  }
  if (step.roster) {
    await walkThroughDoor(step.roster);
  }
};

/** For main's event stream, which awaits nothing: a failure is logged, and the next event or refetch catches up. */
const onActivityInBackground = async (e: ActivityEvent): Promise<void> => {
  try {
    await onActivity(e);
  } catch (error) {
    console.error("Could not apply an activity event", error);
  }
};

/** A login finished, so a CLI is signed in; a runner whose sign-in failed beside one that is ready stays signed out. */
const signedIn = async (): Promise<void> => {
  await setAnswer(authQuery.queryKey, {
    ok: true,
    signedOut: held(authQuery)?.signedOut ?? [],
  });
  await refetch([authQuery.queryKey]);
};

// ---- lifecycle -------------------------------------------------------------

/** Everything an event could have moved, asked for again: the page may have missed any of them. */
const resync = (): void => {
  void refetch(EVERYTHING);
};

let initialized = false;
export const initStore = (): void => {
  if (initialized) {
    return;
  }
  initialized = true;
  // an integration ask in the inbox words its button by it
  void warm(stripeKeyQuery);
  listen("activity", (e) => {
    void onActivityInBackground(e);
  });
  listen("auth", (e: AuthFlowEvent) => {
    if (e.type === "done") {
      void signedIn();
    }
  });
  hearMain(resync);
};
