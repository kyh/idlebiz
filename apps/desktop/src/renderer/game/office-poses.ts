// What a working employee is doing at their desk, as far as the sprite can show.
//
// Every tool call the agent makes arrives with ACP's `kind` — the protocol's
// own discriminant ("read", "edit", "execute", "search", "think", …). The
// title beside it is agent prose ("Read src/app.ts") and differs per CLI, so
// the pose keys off the kind and nothing else.

export type WorkPose = "typing" | "reading" | "thinking";

/** Fallback when a run starts, before its first tool call says otherwise. */
export const DEFAULT_WORK_POSE: WorkPose = "typing";

export function poseForToolKind(kind: string | undefined): WorkPose {
  switch (kind) {
    case "read":
    case "search":
    case "fetch":
      return "reading";
    case "think":
      return "thinking";
    default:
      // edit, delete, move, execute, switch_mode, other, and anything unlabelled:
      // hands on the keyboard is the honest default for "doing something"
      return "typing";
  }
}
