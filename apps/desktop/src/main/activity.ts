import { EventEmitter } from "node:events";
import * as store from "@/main/store/store";
import type { ActivityEvent, ActivityInput } from "@/shared/activity";

// The one way anything in main says "this happened": the event is stamped,
// written to the company's activity.jsonl, and handed to every listener (the
// windows, the tray, the milestone poster). A second path would be a listener
// somebody forgot.

export const activityEvents = new EventEmitter<{ activity: [ActivityEvent] }>();

interface PublishOptions {
  /**
   * Keep it off disk. For a pulse that fires every half minute: the windows
   * should hear it, the log should not fill with it.
   */
  persist?: boolean;
}

export function publishActivity(input: ActivityInput, options: PublishOptions = {}): ActivityEvent {
  const event = store.logActivity({ ...input, createdAt: Date.now() }, options.persist ?? true);
  activityEvents.emit("activity", event);
  return event;
}
