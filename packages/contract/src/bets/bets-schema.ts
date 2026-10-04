import { z } from "zod";
import { KillReasonSchema } from "@repo/domain/domain";

export const killBetInput = z.object({ betId: z.string(), reason: KillReasonSchema });
