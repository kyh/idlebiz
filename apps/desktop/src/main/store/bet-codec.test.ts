import { describe, expect, it } from "vitest";
import { betToDoc, docToBet } from "@/main/store/bet-codec";
import { parseDoc, serializeDoc } from "@/main/store/frontmatter";
import type { Bet, BetClaim, BetState } from "@/shared/bets";

const LANDING: BetClaim = { landingPath: "/b/launch-post", metric: "users" };

const bet = (state: BetState, claim: BetClaim = LANDING): Bet => ({
  budgetUsd: 5,
  claim,
  companyId: "co",
  createdAt: 1,
  hypothesis: "a launch post brings visitors",
  id: "launch-post",
  productId: "app",
  reading: 12,
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

  it("round-trips a revenue bet, which owns a tag and no path", () => {
    const revenue = bet({ kind: "open" }, { metric: "revenue" });
    expect(docToBet(parseDoc(serializeDoc(betToDoc(revenue))), "co")).toEqual(revenue);
  });

  it("refuses a users bet that names no landing path", () => {
    const doc = betToDoc(bet({ kind: "open" }));
    delete doc.metadata.landingPath;
    expect(() => docToBet(doc, "co")).toThrow("expected a claim");
  });

  it("reopens a bet whose state cannot be read", () => {
    const doc = betToDoc(bet({ kind: "measuring", until: 99 }));
    delete doc.metadata.until;
    expect(docToBet(doc, "co").state).toEqual({ kind: "open" });
  });
});
