// The team room: its recent lines, and the founder's word to it.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type { TeamMessage } from "@repo/domain/domain";
import type { Done } from "./done";

export const teamContract = {
  messages: oc
    .input(z.object({ limit: z.number().int().optional() }))
    .output(type<TeamMessage[]>()),
  post: oc.input(z.object({ text: z.string().min(1).max(2000) })).output(type<Done>()),
};
