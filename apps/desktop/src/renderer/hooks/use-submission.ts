import { startTransition, useActionState } from "react";
import { errorMessage } from "@/shared/errors";

/** Where a founder's action stands: every control that writes to main shows these four, and only these. */
export type Submission =
  | { kind: "ready" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "failed"; message: string };

type Settled = Exclude<Submission, { kind: "sending" }>;

const READY: Settled = { kind: "ready" };

export interface Submitting<A> {
  submission: Submission;
  submit: (arg: A) => void;
}

/**
 * One shape for every mutation: the control is busy while main works, and a
 * refusal comes back as a message beside it, never as an unhandled rejection
 * or a control stuck half-sent. The failure is returned as state rather than
 * thrown, since a throw inside an action goes to the error boundary.
 */
export const useSubmission = <A = void>(act: (arg: A) => Promise<void>): Submitting<A> => {
  const [settled, dispatch, pending] = useActionState<Settled, A>(async (_previous, arg) => {
    try {
      await act(arg);
      return { kind: "sent" };
    } catch (error) {
      return { kind: "failed", message: errorMessage(error) };
    }
  }, READY);
  return {
    submission: pending ? { kind: "sending" } : settled,
    submit: (arg) => {
      startTransition(() => {
        dispatch(arg);
      });
    },
  };
};
