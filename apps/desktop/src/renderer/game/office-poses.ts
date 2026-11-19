export type WorkPose = "typing" | "reading" | "thinking";

/** Fallback when a run starts, before its first tool call says otherwise. */
export const DEFAULT_WORK_POSE: WorkPose = "typing";

export const poseForToolKind = (kind: string | undefined) => {
  switch (kind) {
    case "read":
    case "search":
    case "fetch": {
      return "reading" satisfies WorkPose;
    }

    case "think": {
      return "thinking" satisfies WorkPose;
    }

    default: {
      return "typing" satisfies WorkPose;
    }
  }
};
