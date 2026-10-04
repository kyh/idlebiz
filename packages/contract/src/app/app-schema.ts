import { z } from "zod";

export const copyTextInput = z.object({ text: z.string().max(20_000) });
export const setLaunchAtLoginInput = z.object({ on: z.boolean() });
