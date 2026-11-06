// Main's answers as the page holds them: one tanstack-query cache, which main's events and its
// answers to the founder's own actions move.

import {
  CancelledError,
  QueryCache,
  QueryClient,
  QueryObserver,
  skipToken,
  useQuery,
} from "@tanstack/react-query";
import type { DataTag, QueryExecuteOptions, QueryKey } from "@tanstack/react-query";
import { taskIn } from "@repo/domain/domain";
import type {
  Company,
  Employee,
  LoadReport,
  LoadSkip,
  Product,
  RestingRunners,
  Task,
  TaskIn,
  TeamMessage,
} from "@repo/domain/domain";
import type { RunnerId } from "@repo/domain/runners";
import type { Bet } from "@repo/domain/bets";
import { errorMessage } from "@repo/domain/errors";
import type { ProductStatus, StripeKeyStatus } from "@repo/domain/integrations";
import { orpc } from "@/renderer/api";
import { FEED_LINES } from "@/renderer/state/activity-reducer";
import { bootOf } from "@/renderer/state/boot";
import type { Boot } from "@/renderer/state/boot";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // main's state, not a page's visit to it: held for as long as the window is open
      gcTime: Number.POSITIVE_INFINITY,
      // main is on loopback, so the browser being offline says nothing about reaching it
      networkMode: "always",
      // a refusal shows at once, and the founder asks again
      retry: false,
      // an answer holds until an event says it moved
      staleTime: Number.POSITIVE_INFINITY,
    },
  },
  queryCache: new QueryCache({
    // most reads have no screen to show their failure on, and the next event asks again; the
    // procedure alone is named, since an input can hold a pasted token
    onError: (error, query) => {
      console.error("Could not read", query.queryKey[0], error);
    },
  }),
});

export const companyQuery = orpc.company.get.queryOptions();
const saveReportQuery = orpc.save.report.queryOptions();
/** Whether a coding CLI is signed in, by main's probe. */
export const authQuery = orpc.agents.hasAuth.queryOptions();
export const restingQuery = orpc.agents.resting.queryOptions();
export const employeesQuery = orpc.employees.list.queryOptions();
/** Every ask awaiting the founder and every dead letter: the inbox's, the HUD's and the office's. */
export const openTasksQuery = orpc.tasks.list.queryOptions({
  input: { status: ["blocked", "dead"] },
});
const productsQuery = orpc.products.list.queryOptions();
const betsQuery = orpc.bets.list.queryOptions();
const roomQuery = orpc.team.messages.queryOptions({ input: { limit: FEED_LINES } });
export const stripeKeyQuery = orpc.stripe.keyStatus.queryOptions();
/** IdleBiz's own update status, which main's `update` event moves (Settings' Updates row). */
export const updateQuery = orpc.app.update.queryOptions();

// ---- outside React ---------------------------------------------------------

type Keyed<T, E> = QueryExecuteOptions<T, E, T, T, DataTag<QueryKey, T, E>>;

/** The answer the cache holds, or undefined before one lands. */
export const held = <T, E>(options: Keyed<T, E>): T | undefined =>
  queryClient.getQueryData(options.queryKey);

/** Main's answer: the cache's while it is fresh, else the read in flight, else a new one. */
export const read = async <T, E>(options: Keyed<T, E>): Promise<T> => {
  try {
    return await queryClient.query(options);
  } catch (error) {
    // an event's patch cancelled the read before anything was held; the read after it answers
    if (error instanceof CancelledError) {
      return await read(options);
    }
    throw error;
  }
};

/** Asks main ahead of whoever will want the answer; a failure is theirs to see when they read it. */
export const warm = async <T, E>(options: Keyed<T, E>): Promise<void> => {
  try {
    await read(options);
  } catch {
    // the read that needs it fails again, where it is shown
  }
};

/** Hears `select` of an answer now and each time it moves, until the returned function is called. */
export const watch = <T, E, S>(
  options: Keyed<T, E>,
  select: (answer: T) => S,
  heard: (selected: S) => void,
): (() => void) => {
  const observer = new QueryObserver(queryClient, {
    ...options,
    notifyOnChangeProps: ["data"],
    select,
  });
  const hearData = ({ data }: { data: S | undefined }): void => {
    if (data !== undefined) {
      heard(data);
    }
  };
  const stop = observer.subscribe(hearData);
  hearData(observer.getCurrentResult());
  return stop;
};

/**
 * Main's own answer to a change, held at once: newer than any read of it still in flight, which
 * is cancelled rather than let land over it.
 */
export const setAnswer = async <T>(
  queryKey: DataTag<QueryKey, T, unknown>,
  answer: T,
): Promise<void> => {
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData(queryKey, answer);
};

/**
 * An event's change to a held answer, outranking any read in flight as `setAnswer` does. With
 * nothing held there is nothing to change: the refetch the event asks for answers.
 */
export const patchAnswer = async <T>(
  queryKey: DataTag<QueryKey, T, unknown>,
  patch: (held: T) => T,
): Promise<void> => {
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData(queryKey, (current) =>
    current === undefined ? undefined : patch(current),
  );
};

// ---- React -----------------------------------------------------------------

const NOTHING: never[] = [];
const NO_REST: RestingRunners = {};
const UNSET: StripeKeyStatus = { state: "unset" };

export const useCompany = (): Company | null => useQuery(companyQuery).data ?? null;

/** The procedures only a company answers wait on one. */
const useHasCompany = (): boolean => useCompany() !== null;

export const useEmployees = (): Employee[] => {
  const enabled = useHasCompany();
  return useQuery({ ...employeesQuery, enabled }).data ?? NOTHING;
};

const useOpenTasks = <T>(select: (tasks: Task[]) => T[]): T[] => {
  const enabled = useHasCompany();
  return useQuery({ ...openTasksQuery, enabled, select }).data ?? NOTHING;
};

const blockedOf = (tasks: Task[]): TaskIn<"blocked">[] => tasks.filter(taskIn("blocked"));
const deadOf = (tasks: Task[]): TaskIn<"dead">[] => tasks.filter(taskIn("dead"));

/** Awaiting the founder's answer. */
export const usePendingAsks = (): TaskIn<"blocked">[] => useOpenTasks(blockedOf);

/** Dead-lettered, needing a retry. */
export const useStuckTasks = (): TaskIn<"dead">[] => useOpenTasks(deadOf);

/** Everything the company builds, oldest first. */
export const useProducts = (): Product[] => {
  const enabled = useHasCompany();
  return useQuery({ ...productsQuery, enabled }).data ?? NOTHING;
};

/** Where a product really is: its entry and latest deploy. */
export const useProductStatus = (productId: string | undefined): ProductStatus | undefined =>
  useQuery(
    orpc.products.status.queryOptions({
      input: productId === undefined ? skipToken : { productId },
    }),
  ).data;

/** Every bet the company has made, oldest first. */
export const useBets = (): Bet[] => {
  const enabled = useHasCompany();
  return useQuery({ ...betsQuery, enabled }).data ?? NOTHING;
};

interface Room {
  messages: TeamMessage[];
  /** Why main could not say, while nothing it said is held. */
  failure: string | null;
}

/** The room as main keeps it, its newest lines last. */
export const useRoom = (): Room => {
  const enabled = useHasCompany();
  const { data, error } = useQuery({ ...roomQuery, enabled });
  return {
    failure: data === undefined && error !== null ? errorMessage(error) : null,
    messages: data ?? NOTHING,
  };
};

export const useResting = (): RestingRunners => useQuery(restingQuery).data ?? NO_REST;

interface SignIn {
  /** A coding CLI is signed in; null until main's probe answers. */
  authed: boolean | null;
  /** Runners not signed in, a login a turn found refused included: everyone on one waits on a sign-in. */
  signedOut: RunnerId[];
}

export const useAuth = (): SignIn => {
  const { data, isError } = useQuery(authQuery);
  if (data) {
    return { authed: data.ok, signedOut: data.signedOut };
  }
  // left unknown, the office would wait forever; the gate at least offers a sign-in
  return { authed: isError ? false : null, signedOut: NOTHING };
};

/** The key the team charges with and revenue is read with; unset until main answers. */
export const useStripeKey = (): StripeKeyStatus => useQuery(stripeKeyQuery).data ?? UNSET;

/** Packages boot could not read. A skipped company blocks the office (see Boot). */
export const useSaveIssues = (): LoadSkip[] => useQuery(saveReportQuery).data?.skipped ?? NOTHING;

/** What the window waits on to open: the save, the company and, with one, its team and their work. */
export const BOOT_QUERIES = [saveReportQuery, companyQuery, employeesQuery, openTasksQuery];

/** A read the window waits on, as it stands: main's answer once one lands, else why it failed. */
interface Asked<T> {
  data: T | undefined;
  error: Error | null;
}

/** What the window shows, from where the reads it waits on stand: `useBoot`'s, outside React. */
export const bootOfReads = ({
  authed,
  company,
  employees,
  report,
  tasks,
}: {
  /** Null until main's CLI probe answers. */
  authed: boolean | null;
  report: Asked<LoadReport>;
  company: Asked<Company | null>;
  employees: Asked<Employee[]>;
  tasks: Asked<Task[]>;
}): Boot => {
  const hasCompany = company.data !== undefined && company.data !== null;
  const awaited: Asked<unknown>[] = hasCompany
    ? [report, company, employees, tasks]
    : [report, company];
  const failed = awaited.find(({ data, error }) => data === undefined && error !== null);
  return bootOf({
    authed,
    bootFailure: failed?.error ? errorMessage(failed.error) : null,
    booted: awaited.every(({ data }) => data !== undefined),
    hasCompany,
    saveIssues: report.data?.skipped ?? NOTHING,
  });
};

/** What the window shows, re-rendered only when one of its inputs moves. */
export const useBoot = (): Boot => {
  const report = useQuery(saveReportQuery);
  const company = useQuery(companyQuery);
  const hasCompany = company.data !== undefined && company.data !== null;
  const employees = useQuery({ ...employeesQuery, enabled: hasCompany });
  const tasks = useQuery({ ...openTasksQuery, enabled: hasCompany });
  const { authed } = useAuth();
  return bootOfReads({ authed, company, employees, report, tasks });
};
