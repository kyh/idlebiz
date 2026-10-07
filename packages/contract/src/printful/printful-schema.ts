import { z } from "zod";

export const saveTokenInput = z.object({ token: z.string().trim().min(1) });
