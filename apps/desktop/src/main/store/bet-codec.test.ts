import { describe, expect, it } from "vitest";
import { betToDoc, docToBet } from "@/main/store/bet-codec";
import { parseDoc, serializeDoc } from "@/main/store/frontmatter";
import type { Bet, BetState } from "@/shared/bets";

const bet = (state: BetState): Bet => ({
  baseline: 3,
  budgetUsd: 5,
  companyId: "co",
  createdAt: 1,
  hypothesis: "a launch post brings visitors",
  id: "launch-post",
  metric: "users",
  productId: "app",
  spentUsd: 1.25,
  state,
  target: 50,
  title: "Launch post",
  windowHours: 48,
});

describe("bet codec", () => {
  const states: BetState[] = [
    { kind: "open" },
    { kind: "measuring", until: 99 },
    { closedAt: 9, kind: "won", moved: 61 },
    { closedAt: 9, kind: "killed", moved: 4, reason: "users moved 4 of the 50 it needed" },
    { closedAt: 9, kind: "killed", moved: null, reason: "no source ever reported users" },
  ];

  it.each(states)("round-trips a $kind bet through BET.md", (state) => {
    const text = serializeDoc(betToDoc(bet(state)));
    expect(docToBet(parseDoc(text), "co")).toEqual(bet(state));
  });

  it("reopens a bet whose state cannot be read", () => {
    const doc = betToDoc(bet({ kind: "measuring", until: 99 }));
    delete doc.metadata.until;
    expect(docToBet(doc, "co").state).toEqual({ kind: "open" });
  });
});
