import { unreachable } from "@repo/domain/errors";
import { z } from "zod";
import { BetClaimSchema } from "@repo/domain/bets";
import type { Bet, BetState } from "@repo/domain/bets";
import { PACKAGE_SCHEMA, decodeDoc, packageFields } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

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

const statusFields = (st: BetState) => {
  switch (st.kind) {
    case "open": {
      return { status: "open" } satisfies z.input<typeof BetStatusSchema>;
    }

    case "measuring": {
      return { status: "measuring", until: st.until } satisfies z.input<typeof BetStatusSchema>;
    }

    case "won": {
      return { closedAt: st.closedAt, moved: st.moved, status: "won" } satisfies z.input<
        typeof BetStatusSchema
      >;
    }

    case "killed": {
      return {
        closedAt: st.closedAt,
        moved: st.moved ?? undefined,
        reason: st.reason,
        status: "killed",
      } satisfies z.input<typeof BetStatusSchema>;
    }

    default: {
      return unreachable(st);
    }
  }
};

const betState = (m: z.output<typeof BetStatusSchema>) => {
  switch (m.status) {
    case "open": {
      return { kind: "open" } satisfies BetState;
    }

    case "measuring": {
      return { kind: "measuring", until: m.until } satisfies BetState;
    }

    case "won": {
      return { closedAt: m.closedAt, kind: "won", moved: m.moved } satisfies BetState;
    }

    case "killed": {
      return {
        closedAt: m.closedAt,
        kind: "killed",
        moved: m.moved ?? null,
        reason: m.reason,
      } satisfies BetState;
    }

    default: {
      return unreachable(m);
    }
  }
};

export const betToDoc = (b: Bet) =>
  ({
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
  }) satisfies z.input<typeof BetDocSchema>;

export const docToBet = (doc: FrontmatterDoc) => {
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
  } satisfies Bet;
};
