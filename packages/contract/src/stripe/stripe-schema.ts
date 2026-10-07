import { z } from "zod";

export const saveKeyInput = z.object({ key: z.string().trim().min(1) });
