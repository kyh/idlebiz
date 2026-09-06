import { EventEmitter } from "node:events";
import * as store from "@/main/store/store";
import type { ActivityEvent, ActivityInput } from "@/shared/activity";

// All main-process activity is stamped, persisted, and broadcast through publishActivity.

export const activityEvents = new EventEmitter<{ activity: [ActivityEvent] }>();

interface PublishOptions {
  /** False broadcasts transient events without adding them to history. */
  persist?: boolean;
}

export function publishActivity(input: ActivityInput, options: PublishOptions = {}): ActivityEvent {
  const event = store.logActivity({ ...input, createdAt: Date.now() }, options.persist ?? true);
  activityEvents.emit("activity", event);
  return event;
}
