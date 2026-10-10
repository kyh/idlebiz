import { describe, expect, it } from "vitest";
import { betToDoc, docToBet } from "./bet-codec";
import { parseDoc, serializeDoc } from "./frontmatter";
import type { Bet, BetClaim, BetState } from "@repo/domain/bets";

const LANDING: BetClaim = { landingPath: "/b/launch-post", metric: "users" };

const bet = (state: BetState, claim: BetClaim = LANDING): Bet => ({
  budgetUsd: 5,
  claim,
  companyId: "co",
  createdAt: 1,
  hypothesis: "a launch post brings visitors",
  id: "launch-post",
  productId: "app",
  readAt: 7,
  reading: 12,
  spentUsd: 1.25,
  state,
  target: 50,
  title: "Launch post",
  windowHours: 48,
});

/** The bet's BET.md, as boot reads it back. */
const written = (b: Bet) => parseDoc(serializeDoc(betToDoc(b)));

describe("bet codec", () => {
  const states: BetState[] = [
    { kind: "open" },
    { kind: "measuring", until: 99 },
    { closedAt: 9, kind: "won", moved: 61 },
    { closedAt: 9, kind: "killed", moved: 4, reason: "users moved 4 of the 50 it needed" },
    { closedAt: 9, kind: "killed", moved: null, reason: "no source ever reported users" },
  ];

  it.each(states)("round-trips a $kind bet through BET.md", (state) => {
    expect(docToBet(written(bet(state)), "co")).toEqual(bet(state));
  });

  it("round-trips a revenue bet, which owns a tag and no path", () => {
    const revenue = bet({ kind: "open" }, { metric: "revenue" });
    expect(docToBet(written(revenue), "co")).toEqual(revenue);
  });

  it("reads a bet whose reading carries no time as never read", () => {
    const doc = written(bet({ kind: "measuring", until: 99 }));
    delete doc.metadata.readAt;
    expect(docToBet(doc, "co").readAt).toBeNull();
  });

  it("refuses a bet on a number it does not know", () => {
    const doc = written(bet({ kind: "open" }));
    doc.metadata.metric = "vibes";
    expect(() => docToBet(doc, "co")).toThrow("metadata.metric");
  });
});
