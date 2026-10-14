import type { JsonValue } from "@repo/domain/json";
import type { ToolName, ToolOutcome } from "../tool-specs";
import type { RunContext, Tool } from "./define";
import { MONEY_TOOLS } from "./money";
import { PORTFOLIO_TOOLS } from "./portfolio";
import { PRINT_TOOLS } from "./print";
import { TEAM_TOOLS } from "./team";
import { VERCEL_TOOLS } from "./vercel";

const TOOLS = {
  ...TEAM_TOOLS,
  ...PORTFOLIO_TOOLS,
  ...VERCEL_TOOLS,
  ...MONEY_TOOLS,
  ...PRINT_TOOLS,
} satisfies Record<ToolName, Tool>;

/** Call the tool `name` with whatever the agent sent. */
export const callTool = (ctx: RunContext, name: ToolName, raw: JsonValue): Promise<ToolOutcome> =>
  TOOLS[name](ctx, name, raw);
