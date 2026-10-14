import { z } from "zod";
import { BetClaimSchema } from "@repo/domain/bets";
import type { Bet, BetState } from "@repo/domain/bets";
import { PACKAGE_SCHEMA, decodeDoc, packageFields } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

/** The fields every bet carries; a null one gets no line. */
const BetFieldsSchema = z.object({
  budgetUsd: z.number(),
  createdAt: z.number(),
  productId: z.string(),
  readAt: z.number().optional(),
  reading: z.number().optional(),
  spentUsd: z.number(),
  target: z.number(),
  windowHours: z.number(),
});

// State-specific fields sit flat in the metadata block, like TASK.md, so a BET.md stays hand-editable.
const BetStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open") }),
  z.object({ status: z.literal("measuring"), until: z.number() }),
  z.object({ closedAt: z.number(), moved: z.number(), status: z.literal("won") }),
  z.object({
    closedAt: z.number(),
    moved: z.number().optional(),
    reason: z.string(),
    status: z.literal("killed"),
  }),
]);

const BetDocSchema = z.object({
  body: z.string(),
  fields: packageFields("bet"),
  metadata: z.intersection(z.intersection(BetFieldsSchema, BetStatusSchema), BetClaimSchema),
});

const statusFields = (st: BetState): z.input<typeof BetStatusSchema> => {
  switch (st.kind) {
    case "open": {
      return { status: "open" };
    }
    case "measuring": {
      return { status: "measuring", until: st.until };
    }
    case "won": {
      return { closedAt: st.closedAt, moved: st.moved, status: "won" };
    }
    case "killed": {
      return {
        closedAt: st.closedAt,
        moved: st.moved ?? undefined,
        reason: st.reason,
        status: "killed",
      };
    }
    // no default
  }
};

const betState = (m: z.output<typeof BetStatusSchema>): BetState => {
  switch (m.status) {
    case "open": {
      return { kind: "open" };
    }
    case "measuring": {
      return { kind: "measuring", until: m.until };
    }
    case "won": {
      return { closedAt: m.closedAt, kind: "won", moved: m.moved };
    }
    case "killed": {
      return { closedAt: m.closedAt, kind: "killed", moved: m.moved ?? null, reason: m.reason };
    }
    // no default
  }
};

export const betToDoc = (b: Bet): z.input<typeof BetDocSchema> => ({
  body: `${b.hypothesis}\n`,
  fields: { kind: "bet", name: b.title, schema: PACKAGE_SCHEMA, slug: b.id },
  metadata: {
    budgetUsd: b.budgetUsd,
    createdAt: b.createdAt,
    productId: b.productId,
    readAt: b.readAt ?? undefined,
    reading: b.reading ?? undefined,
    spentUsd: b.spentUsd,
    target: b.target,
    windowHours: b.windowHours,
    ...b.claim,
    ...statusFields(b.state),
  },
});

export const docToBet = (doc: FrontmatterDoc): Bet => {
  const { body, fields, metadata: m } = decodeDoc(BetDocSchema, doc);
  return {
    budgetUsd: m.budgetUsd,
    claim:
      m.metric === "users"
        ? { landingPath: m.landingPath, metric: "users" }
        : { metric: "revenue" },
    createdAt: m.createdAt,
    hypothesis: body.trim(),
    id: fields.slug,
    productId: m.productId,
    readAt: m.readAt ?? null,
    reading: m.reading ?? null,
    spentUsd: m.spentUsd,
    state: betState(m),
    target: m.target,
    title: fields.name,
    windowHours: m.windowHours,
  };
};
