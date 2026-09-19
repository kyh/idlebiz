import { BET_METRICS, BetStateSchema } from "@/shared/bets";
import type { Bet, BetState } from "@/shared/bets";
import { nullableNum, optNum, optStr, reqNum, reqStr } from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";

// State-specific fields sit flat in the metadata block, like TASK.md, so a BET.md stays hand-editable.
export const betToDoc = (b: Bet): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    baseline: b.baseline,
    budgetUsd: b.budgetUsd,
    createdAt: b.createdAt,
    metric: b.metric,
    productId: b.productId,
    spentUsd: b.spentUsd,
    status: b.state.kind,
    target: b.target,
    windowHours: b.windowHours,
  };
  const st = b.state;
  switch (st.kind) {
    case "open": {
      break;
    }
    case "measuring": {
      metadata.until = st.until;
      break;
    }
    case "won": {
      metadata.closedAt = st.closedAt;
      metadata.moved = st.moved;
      break;
    }
    case "killed": {
      metadata.closedAt = st.closedAt;
      metadata.reason = st.reason;
      if (st.moved !== null) {
        metadata.moved = st.moved;
      }
      break;
    }
    // no default
  }
  return {
    body: `${b.hypothesis}\n`,
    fields: { kind: "bet", name: b.title, schema: "agentcompanies/v1", slug: b.id },
    metadata,
  };
};

const parseState = (m: FrontmatterDoc["metadata"]): BetState => {
  const parsed = BetStateSchema.safeParse({
    closedAt: nullableNum(m, "closedAt") ?? undefined,
    kind: optStr(m, "status"),
    moved: nullableNum(m, "moved"),
    reason: optStr(m, "reason") ?? "",
    until: nullableNum(m, "until") ?? undefined,
  });
  // an unreadable state reopens the bet: the evaluator judges it again from the real numbers
  return parsed.success ? parsed.data : { kind: "open" };
};

export const docToBet = (doc: FrontmatterDoc, companyId: string): Bet => {
  const m = doc.metadata;
  const metricRaw = optStr(m, "metric");
  const metric = BET_METRICS.find((k) => k === metricRaw);
  if (!metric) {
    throw new Error(`expected metric to be one of ${BET_METRICS.join(", ")}`);
  }
  return {
    baseline: optNum(m, "baseline", 0),
    budgetUsd: reqNum(m, "budgetUsd"),
    companyId,
    createdAt: reqNum(m, "createdAt"),
    hypothesis: doc.body.trim(),
    id: reqStr(doc.fields, "slug"),
    metric,
    productId: reqStr(m, "productId"),
    spentUsd: optNum(m, "spentUsd", 0),
    state: parseState(m),
    target: reqNum(m, "target"),
    title: reqStr(doc.fields, "name"),
    windowHours: reqNum(m, "windowHours"),
  };
};
