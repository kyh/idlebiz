import type { LoadSkip } from "@/shared/domain";

/**
 * What the window shows: exactly one of these. A company boot could not read
 * stops everything (a fresh start here would stack a second company on it);
 * so does a first refresh that failed, until a retry lands; no company means
 * onboarding; a company means the office, or the sign-in gate when no CLI is
 * signed in.
 */
export type Boot =
  | { kind: "loading" }
  | { kind: "unreadable"; issues: LoadSkip[] }
  | { kind: "unreachable"; message: string }
  | { kind: "onboarding" }
  | { kind: "signed-out" }
  | { kind: "office" };

export const bootOf = ({
  saveIssues,
  booted,
  bootFailure,
  hasCompany,
  authed,
}: {
  saveIssues: readonly LoadSkip[];
  /** The first refresh finished. */
  booted: boolean;
  /** Why the last refresh before boot failed; null while none has. */
  bootFailure: string | null;
  hasCompany: boolean;
  /** Null until main's CLI probe answers. */
  authed: boolean | null;
}): Boot => {
  const issues = saveIssues.filter((issue) => issue.kind === "company");
  if (issues.length > 0) {
    return { issues, kind: "unreadable" };
  }
  if (!booted) {
    return bootFailure === null
      ? { kind: "loading" }
      : { kind: "unreachable", message: bootFailure };
  }
  if (!hasCompany) {
    return { kind: "onboarding" };
  }
  // Not the office on a guess: its digest would take the founder's look and
  // then vanish under the gate, and the absence would go unreported.
  if (authed === null) {
    return { kind: "loading" };
  }
  return authed ? { kind: "office" } : { kind: "signed-out" };
};
