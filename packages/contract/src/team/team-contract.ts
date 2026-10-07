// The team room: its recent lines, and the founder's word to it.

import { oc, type } from "@orpc/contract";
import type { TeamMessage } from "@repo/domain/domain";
import type { Done } from "../done";
import { messagesInput, postInput } from "./team-schema";

export const teamContract = {
  messages: oc.input(messagesInput).output(type<TeamMessage[]>()),
  post: oc.input(postInput).output(type<Done>()),
};
