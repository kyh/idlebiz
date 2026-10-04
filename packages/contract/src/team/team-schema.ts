import { z } from "zod";

export const messagesInput = z.object({ limit: z.number().int().optional() });
export const postInput = z.object({ text: z.string().min(1).max(2000) });
