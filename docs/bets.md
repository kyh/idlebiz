# Bets steer the company

Paths are short, as in [AGENTS.md](../AGENTS.md); the decisions behind it are `CLAUDE.md`'s.

`@repo/domain/bets` is the whole steering loop, pure: a bet is one hypothesis about one real
number (`users` | `revenue`) of one product, with a spend cap and a window. Its target has a
floor, `MIN_BET_TARGET` (10 whole users, $5), which `open_bet`'s body refuses below.

- **The verdict.** `judge` runs every scheduler tick against the live product numbers: won when
  the number moved by the target, killed when its window closes short — on a reading taken after
  the close (the pulse reads at boot and re-reads Stripe past its cache for it), since a cached
  read can miss the money that decides it. A measuring bet's reading stops at its close — visits
  up to `until`, charges made by it — so however late that read comes, nothing after the window
  counts. Without one, the verdict holds for a second window (`windowHours` past the close), then
  the bet dies on its last reading with a reason naming the source that sent nothing — but only
  once the pulse has asked for `KILL_GRACE_MS` without a break (`pulsingSince`), so a window that
  closed while the app was quit or asleep waits on a read, not the wall clock. The founder or the
  lead can still kill a held bet by hand.
- **The window.** Only the lead starts one (`measure_bet`): spending out the budget stops the
  work but not the clock, because the step that moves the number may still be waiting on the
  founder and a window over nothing shipped is a false verdict. Nor does it start one over a
  number no source reads (`measureRefusal`: the company's Stripe key, live unless test money
  counts, and the product's Vercel project). A spent-out bet gets the lead a "settle" run:
  measure or kill. One that ends done with neither closes the bet unmeasured
  (`closeUnsettledBet`): no window ran, and briefing the lead again would bill the bet a run
  every tick.
- **The mark** (`Bet.claim`). A users bet owns a landing path (`/b/<slug>` unless it names one)
  and reads visitors under it since it opened; a revenue bet reads captured live-mode USD charges
  tagged `metadata[bet]=<slug>`, the tag `create_payment_link` and `sell_print` set on every
  payment of a link made for that bet. A named path over the whole site or `/b` is refused
  (`namedPathRefusal`), and so is one overlapping a path a live bet covers or a closed one named
  (`holdsItsPath`): each counts visitors the bet did not bring. The team's own visits never count;
  the standing instructions say how to check a path without recording one. Readings arrive with
  the metrics pulse and live on the bet (`reading`, taken at `readAt`), so `judge` needs only the
  bet and the pulse's clock. Vercel's analytics API wants `since` and `until` together and filters
  in OData; path filters are free, utm ones are a paid add-on — which is why the mark is a path.
- **Revenue.** Per-product revenue reads the same charges over the account's whole history, tagged
  `metadata[product]`, while bets read only charges since the oldest live revenue bet opened;
  untagged money counts for the company only. Test-mode money counts nowhere unless
  `IDLEBIZ_COUNT_TEST_MONEY=1` ([Configuration](../AGENTS.md#configuration)); without it a test-mode
  key gives a bet no reading, not a zero, so a bet only it could read closes unmeasured, never as a
  loss.
- **Where a run goes.** `allocate` decides everything about it, and the scheduler only carries
  it out: work on the best open bet (product yield + exploration bonus − crowding, runs in flight
  counted against the budget at ~$1 each), else the lead settles a spent-out bet, else the lead
  opens the next one (a run of straight losses asks for new ground), else wait. That budget check
  is `hasRoomFor`, and `delegate` asks it too: a bet without room refuses the handoff rather than
  let its work run unfunded. The portfolio's caps (5 live products, 3 live bets a product) are the
  store's: `createProduct` and `openBet` refuse past them, the founder's New product too, and a
  proposal offers new ground as a new product only while `portfolioHasRoom`.
- **Waiting on the founder** is modelled in `allocate` once: a bet with a blocked task gets no
  hands — settle runs carry their bet, so that covers them — and a lead whose last proposal is
  blocked is not asked again. Nor is one whose last proposal ended done with no news on the
  ledger since it was briefed (`proposalIdle`: no bet opened or closed, no product started), the
  same brief getting the same answer, until it is `PROPOSAL_RETRY_MS` (15 minutes) old, since the
  room or a connection may have moved meanwhile. A proposal that ends done is noted in
  `state/last-proposal.json` (`store.lastProposalDone`), so allocating reads no history.
- **Work a bet no longer funds.** A bet that leaves open (measured, killed, judged) drops its
  waiting work, and a run still on it that fails, parks or is cut off by a restart is dropped
  instead of queueing again, as is one that asks the founder once the bet has closed; measuring
  keeps what waits on the founder and the continuation carrying their answer, whose run is dropped
  only when it fails, since that step may be what moves the number. A continuation names the ask
  it answers (`answers` in its TASK.md, set only by `resolveBlockedWithAnswer`), so measuring,
  parking, a restart and a release read it there and never load `shipped/`. Retiring a product
  drops its waiting work and switches off its payment links, and the retiring run's own task, on
  no bet, is dropped the same way when it fails, parks, asks or is cut off, since a retry would
  run in the company's folder. A release drops the leaver's unstarted work and any ask no bet
  funds; a funded ask, and the continuation carrying the founder's answer to one, go to the lead.
- **`dropped` is history, not a failure**: the Inbox never offers it back and the lead's brief
  never lists it, since reviving it would only bill what takes no more work; the lead delegates
  the idea again under a live bet. `dead` is only work whose runs failed on their own, and stays
  revivable while its bet is open and its product live: a bet that leaves open or a product that
  retires drops its dead work too, since `claimTask` refuses anything else a run would bill.
- **The replay.** `dream` replays a fixed set of `explore` weights against the measured verdicts
  and swaps only to a strictly better scorer, so the incumbent never loses to a tie. A bet closed
  unmeasured (`moved === null`: killed before any source reported its number, or left unsettled)
  says nothing about its hypothesis, so neither the replay nor `allocate` (product yield, the
  plateau's run of losses) counts it. The replay scores only work picks and floors a pick's cost
  at one run's, so a win nothing paid for cannot price itself at zero; the plateau (three straight
  losses) only shapes a proposal, so it is a constant, not policy. It never retunes below eight
  measured verdicts.
