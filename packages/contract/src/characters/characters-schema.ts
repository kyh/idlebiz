import { z } from "zod";

export const composeCharacterInput = z.object({ seed: z.string() });
