import { useMemo, useSyncExternalStore } from "react";
import type { QueryKey } from "@tanstack/react-query";
import type { ActivityEvent } from "@repo/domain/activity";
import type { AuthFlowEvent, Budget, Company, Employee, Task } from "@repo/domain/domain";
import { api, orpc } from "@/renderer/api";
import { hearMain, listen } from "@/renderer/page-events";
import { reportFault } from "@/renderer/report-fault";
import { hear, tell } from "@/renderer/game/office-port";
import type { Office } from "@/renderer/game/office-port";
import { EVERYTHING, joinFeed, reduceActivity, roomLines } from "@/renderer/state/activity-reducer";
import type { FeedLine } from "@/renderer/state/activity-reducer";
import type { Boot } from "@/renderer/state/boot";
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
  updateQuery,
  useRoom,
  warm,
} from "@/renderer/state/queries";
import type { HoldRuleId } from "@repo/domain/hold-rules";

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

const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };

  for (const l of listeners) {
    l();
  }
};

const subscribe = (l: () => void) => {
  listeners.add(l);

  return (() => listeners.delete(l)) satisfies () => void;
};

/**
 * Subscribe to one value in the store. The component re-renders only when it
 * changes — so select a field, not a fresh object.
 */
export const useStore = <T>(selector: (s: State) => T) => {
  const select = () => selector(state);

  return useSyncExternalStore(subscribe, select, select);
};

/** What #team shows, newest last: the room as main keeps it, and the news heard since the window opened. */
export const useFeed = () => {
  const heard = useStore((s) => s.feed);
  const { messages } = useRoom();

  return useMemo(() => joinFeed(heard, roomLines(messages)), [heard, messages]);
};

const syncModal = () => {
  if (state.game) {
    tell(state.game, "ui-modal", state.modalOpen);
  }
};

let stopHearingInputReady: (() => void) | null = null;

export const setGame = (game: Office | null) => {
  stopHearingInputReady?.();
  set({ game });
  stopHearingInputReady = game ? hear(game, "office-input-ready", syncModal) : null;
  syncModal();
};

export const setTalkingTo = (employeeId: string | null) => {
  set({ talkingTo: employeeId });
};

/** Toggle Phaser keyboard so typing in overlays doesn't move the player. */
export const setModalOpen = (open: boolean) => {
  set({ modalOpen: open });
  syncModal();
};

/** Ask main again for what the window waits on to open, failing as the first of those reads fails. */
export const refresh = async () => {
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
export const companyFounded = async () => {
  await Promise.all([
    read({ ...employeesQuery, staleTime: 0 }),
    read({ ...openTasksQuery, staleTime: 0 }),
  ]);
  await read({ ...companyQuery, staleTime: 0 });

  if (state.game) {
    tell(state.game, "company-ready", null);
  }
};

let unreached = false;

/**
 * Where the window's boot got to, as it shows it. Once main answers after the window could not
 * reach it, by a retry or by a resync, the office boots again on those answers: its own reads
 * failed with the window's, or never ran, and nothing else starts it again.
 */
export const bootShown = (kind: Boot["kind"]) => {
  if (kind === "unreachable") {
    unreached = true;

    return;
  }

  if (kind === "loading" || !unreached) {
    return;
  }

  unreached = false;

  if (state.game) {
    tell(state.game, "company-ready", null);
  }
};

const withCompany = async (act: () => Promise<void>) => {
  if (held(companyQuery)) {
    await act();
  }
};

const updateCompany = (call: () => Promise<Company>) =>
  withCompany(async () => {
    await setAnswer(companyQuery.queryKey, await call());
  });

const productsMoved = async () => {
  await queryClient.invalidateQueries({ queryKey: orpc.products.key() });
};

export const createProduct = (name: string, description: string) =>
  withCompany(async () => {
    await api.products.create({ description, name });
    await productsMoved();
  });

export const setAutopilot = (running: boolean) =>
  updateCompany(() => api.company.setAutopilot({ running }));

export const setBudget = (budget: Budget) => updateCompany(() => api.company.setBudget({ budget }));

export const resetSpend = () => updateCompany(() => api.company.resetSpend());

/** What happened since the founder last looked; asking is the look. */
export const digest = () => (held(companyQuery) ? api.company.takeDigest() : Promise.resolve(null));

export const setMaxAgents = (maxAgents: number) =>
  updateCompany(() => api.company.setMaxAgents({ maxAgents }));

export const setStandingSignOff = (rule: HoldRuleId, on: boolean) =>
  updateCompany(() => api.company.setStandingSignOff({ on, rule }));

export const connectVercel = async (input: {
  productId: string;
  /** Absent: keep the saved token. */
  token?: string | undefined;
  projectId: string;
  projectName: string;
  teamId?: string | undefined;
}) => {
  await api.vercel.connect(input);
  await productsMoved();
};

export const disconnectVercel = async (productId: string) => {
  await api.vercel.disconnect({ productId });
  await productsMoved();
};

export const directEmployee = async (employeeId: string, instruction: string) => {
  const text = instruction.trim();

  if (!text) {
    return;
  }

  await api.employees.direct({ employeeId, instruction: text });
};

/** Founder posts in the team channel; @first-name wakes that employee. */
export const sendFounderChat = (text: string) =>
  withCompany(async () => {
    if (text.trim()) {
      await api.team.post({ text: text.trim() });
    }
  });

/** Revive a dead-lettered / failed task: re-assign it (the claim resets retries). */
export const retryTask = async (task: Task) => {
  if (!task.assigneeId) {
    return;
  }

  await api.tasks.assign({ employeeId: task.assigneeId, taskId: task.id });
};

const findHire = async (employeeId: string) => {
  const isHire = (emp: Employee) => emp.id === employeeId;
  const found = held(employeesQuery)?.find(isHire);

  if (found) {
    return found;
  }

  const roster = await read({ ...employeesQuery, staleTime: 0 }).catch(() => null);

  return roster?.find(isHire);
};

const walkThroughDoor = async (roster: { employeeId: string; hired: boolean }) => {
  if (!state.game) {
    return;
  }

  if (!roster.hired) {
    tell(state.game, "despawn-employee", roster.employeeId);

    return;
  }

  const hire = await findHire(roster.employeeId);
  const { game } = state;

  if (hire && game) {
    tell(game, "spawn-employee", hire);
  }
};

const refetch = async (queryKeys: readonly QueryKey[]) => {
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
};

const onActivity = async (e: ActivityEvent) => {
  const step = reduceActivity(state, e);
  set(step.heard);

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

let applying = 0;
let onApplied: (() => void)[] = [];

const allApplied = () =>
  (applying === 0
    ? Promise.resolve()
    : // oxlint-disable-next-line promise/avoid-new -- settled by the last event still being applied
      new Promise((resolve) => {
        onApplied.push(resolve);
      })) satisfies Promise<void>;

const onActivityInBackground = async (e: ActivityEvent) => {
  applying += 1;

  try {
    await onActivity(e);
  } catch (error) {
    console.error("Could not apply an activity event", error);
    reportFault("activity", error);
  } finally {
    applying -= 1;

    if (applying === 0) {
      const waiting = onApplied;
      onApplied = [];

      for (const resolve of waiting) {
        resolve();
      }
    }
  }
};

const signedIn = async () => {
  await setAnswer(authQuery.queryKey, {
    ok: true,
    signedOut: held(authQuery)?.signedOut ?? [],
  });
  await refetch([authQuery.queryKey]);
};

const resync = async () => {
  await refetch(EVERYTHING);

  if (!held(companyQuery)) {
    return;
  }

  try {
    await Promise.all([read(employeesQuery), read(openTasksQuery)]);
  } catch {
    return;
  }

  await allApplied();
  const { game } = state;

  if (!game) {
    return;
  }

  try {
    tell(game, "resynced", null);
  } catch (error) {
    console.error("Could not set the office right", error);
    reportFault("resync", error);
  }
};

let initialized = false;

export const initStore = () => {
  if (initialized) {
    return;
  }

  initialized = true;
  void warm(stripeKeyQuery);
  listen("activity", (e) => {
    void onActivityInBackground(e);
  });
  listen("auth", (e: AuthFlowEvent) => {
    if (e.type === "done") {
      void signedIn();
    }
  });
  listen("update", (status) => {
    void setAnswer(updateQuery.queryKey, status);
  });
  hearMain(() => {
    void resync();
  });
};
