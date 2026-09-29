---
name: digital-product
description: How to research, make and sell a digital product (a guide, ebook, template, checklist, course, deal memo or paid unlock) straight from the product's own site, where a bet can count every sale. Use it whenever a bet or task is about picking, writing, packaging, pricing, launching or selling something digital that is bought once through create_payment_link, whatever the business type.
---

# Digital product playbook

Find a specific buyer with a proven, lasting problem; write the thing that solves it better
than what they can already buy; sell it from the product's own page through
create_payment_link, so the app can count every sale against a bet. Your standing
instructions win wherever this differs from them: every tool named here is described there.

## When to use it

- Any business type selling something digital once: a guide or ebook, a template or
  checklist, a course, a deal memo or teardown pack, a paid unlock of a web page or game.
- Picking what to sell next, or why one is not selling (the research below usually says).
- Not for physical goods (sell_print) or anything that needs a subscription: no tool makes one.

## Ground rules

- **Sell direct.** A revenue bet counts only captured USD charges tagged
  `metadata[bet]=<bet slug>`, which create_payment_link sets when you pass `"bet":"<slug>"`.
  A sale made anywhere else (a marketplace, a store, a DM) is real but no bet can see it.
- **Read, never scrape.** Research is a person reading pages: your own web tools, `curl`, or
  `agent-browser open` plus `snapshot`/`screenshot`. A handful of pages per source, notes by
  hand. No crawling, no paging through listings in a loop, no sign-in, no disguising the
  browser. The team has no API for Google Trends or Amazon, and both turn automated reading
  away: if either shows a captcha, asks you to sign in or refuses, stop there and work from
  what you have.
- **Filters by URL, never by click.** Clicking, typing or choosing on a page that is not your
  own build is held for the founder. Open a sorted or filtered view by its URL
  (`agent-browser open`, `curl`), as the Trends link below does; where a filter has no URL,
  read what the page shows.
- **Honest.** No income or results claims ("make $X", "guaranteed"), no invented credentials,
  experience, case studies or testimonials, no fake, bought, solicited or incentivised reviews,
  no copied text, structure or art.
- **Founder steps are asks.** Posting, signing up, making a Stripe key: an ask_boss action.
  Each deploy and each payment link waits on the founder's sign-off. Only a run's first ask
  reaches the founder, so plan the sequence across runs and do everything else in between.

## 1. Research

Keep the notes in the company workspace (shared across products), one file per niche, so the
next product in it starts from them.

### Demand that lasts: five years, not five weeks

- [ ] Open Google Trends over five years for two to four phrasings of the problem at once:
      `https://trends.google.com/trends/explore?date=today%205-y&q=<term>,<term>`.
      Screenshot it and read the lines.
- [ ] Keep: a flat or rising line, or a season that repeats every year.
      Drop: one spike that fades (a fad), or a line near zero (nobody searches for it).
- [ ] Note the date and what each line did. A trend says people look; it does not say they pay.

### Proof that people pay

- [ ] Find where this kind of thing already sells: the category's best-seller list in the
      Kindle store, Etsy, Gumroad, Udemy, a niche marketplace.
- [ ] For the top three to five competitors note title, price, sales rank and review count.
      Several titles with many reviews means proven demand. No competitors at all usually
      means no buyers, not an open field.
- [ ] Find where the buyers talk (subreddits, forums, Q&A sites, groups) and the question
      they keep asking. That place is also the launch channel (section 4).

### Niche down

- [ ] Write one line: a specific person, in a specific situation, who wants one outcome.
      "First-time landlords writing their first lease", not "real estate".
- [ ] Test it: you can name where that person spends time online, a title can say it in a few
      words, and the top competitors serve them only in passing.
- [ ] Too broad means the big titles already own it. Too narrow means no trend line and no
      competitors. Move one step at a time and read again.

### Mine the three-star reviews

- [ ] For each top competitor, read its three-star reviews. Those buyers wanted the thing
      and say exactly what was missing. One-star reviews are mostly delivery and format
      complaints; five-star ones say little.
- [ ] On Amazon, read only the reviews on the product page itself: its full review list and
      star filters ask you to sign in. Pick the three-star ones out of what that page shows.
      Where the same kind of product sells somewhere whose reviews open signed out (check with
      one `curl -I` or `agent-browser open`), read more there, through a URL filter if it has
      one.
- [ ] Note, per competitor: what readers wanted and did not get, what felt padded, dated,
      generic or too advanced, and complaints about the format.
- [ ] Reviews are research. Never quote a reviewer in public copy.
- [ ] Write the brief in the product's workspace:

```md
# <working title>

Buyer: <the one line from "Niche down">
Demand: <Trends reading, dated> · <competitors: title, price, rank, reviews>
Gaps: <what three-star reviewers missed, one bullet each, with its competitor>
Promise: <what the buyer can do after reading that they could not before>
Format: <web guide behind the unlock | PDF | template | course pages>
Price: <USD, and the competitor prices it sits among>
Channel: <the one place the launch goes, and its rules on self-promotion>
```

## 2. Make it

- [ ] **Outline** from the brief: every section closes a gap or serves the promise. Cut what
      does neither before writing a word of it.
- [ ] **Draft**, then **edit** in a separate pass: shorter sentences, examples specific to the
      buyer, no padding, no filler intro.
- [ ] **Fact-check** every figure, law, price and procedure against a primary source, cite it,
      and date what will change. Legal, tax, medical or financial topics stay general
      information, say so, and point to a professional.
- [ ] Write as the company. Never invent an author's credentials or story.
- [ ] **Package** it, in order of preference:
  - Pages the product's server serves only once the buyer is unlocked: readable anywhere,
    easy to update.
  - A file (PDF, template, zip) handed over by a server route that checks the purchase first.
    Never put it in `public/` or any static folder: anyone with the URL gets it free. A PDF
    can be printed from a page of your own local build with `agent-browser pdf`.
  - The founder sends it: create_payment_link's `delivery` names the file, and each sale
    reaches them as a card. Fine for the first sales; it costs the founder time on every one.
- [ ] **Cover or hero image**: study the category's covers (type, colour, layout buyers
      recognise at a glance), then make your own in HTML/CSS or SVG and render it with
      `agent-browser screenshot` of your own build. Only fonts and images you may use (Google
      Fonts, your own work). Never a competitor's art, a trademark or a lookalike title. It
      must read at thumbnail size.
- [ ] Put one strong section free on the landing page: it proves the quality before the price.

## 3. Sell it direct

- [ ] **Bet shape** (the lead opens it): usually `revenue`, target at least $5 and roughly
      price × the sales you expect the channel to bring in the window. A `users` bet (at
      least 10) fits a free sample meant to test a channel before the paid version exists.
- [ ] **Landing page** on the product's deploy: who it is for, the problem, what is inside,
      the free section, the price, one buy button, what happens after paying.
  - `users` bet: every link anyone places points at its landing path, `/b/<bet slug>`, or the
    new section the lead named as `landingPath` when the bet is this page. `/b/<bet slug>` must
    serve this page, but the one rewrite in "Marking a bet's traffic" serves the home page
    there. On a storefront with more than the home page, add a rewrite of that exact path to
    this page, listed before `/b/:bet`, since Vercel takes the first that matches:
    `{"source":"/b/<bet slug>","destination":"/<this page>"}`.
  - `revenue` bet: any page, but its buy button is the link made for that bet.
- [ ] **Unlock route** first, as "Checking who paid" in your instructions shows: a server route
      such as `/unlock`, deployed to production, because `afterPaymentUrl` must already be
      live there.
- [ ] **Keys**: one read key and one signing secret serve every item on the product, so skip
      this when an earlier item already set them; note in the product's workspace once they
      are, so the next item knows. Otherwise, an ask_boss action for the founder to make the
      restricted key (Checkout Sessions: Read only, exactly as "Checking who paid" words it),
      then set_env it as `STRIPE_CHECKOUT_READ_KEY`. Make `UNLOCK_SIGNING_SECRET` with
      `openssl rand -base64 32` and set_env it too. A variable takes effect on the next deploy.
- [ ] **Payment link**: create_payment_link with `name` (what the buyer gets), `amountUsd`,
      `"bet":"<slug>"` and `afterPaymentUrl` `https://<production domain>/unlock`; `delivery`
      only when the founder hands something over. Call again once the founder signs off.
- [ ] Put the link's id in the unlock check and its URL on the buy button, then deploy again.
- [ ] One link per item per revenue bet: the bet tag is fixed when the link is made, so a new
      bet on the same item needs a new link.
- [ ] "Checking who paid" checks one link. With several links, map each link id to its item
      (a new bet's link to the same item as the last), pick the item from the session's
      `payment_link` in the unlock route, refuse an id the map lacks, keep a cookie per item
      with the item in what it signs, and redirect to that item's page rather than `/`.
- [ ] **Check** before the lead calls it live: `curl -I` the landing page and `/unlock` (with
      no `session_id` it sends the visitor home), and the paid part refuses without the
      cookie. Never load a users bet's path in a way the analytics would record.
- [ ] **Price** among what competitors charge for the same depth. A narrower promise can ask
      more than a broad one; never discount against an invented "regular price".

## 4. Launch

- [ ] One channel per bet, from the brief, so the verdict says something about it.
- [ ] Read the community's rules before drafting: self-promotion, flair, links, disclosure.
      If it bans promotion, pick another place, or share only the free section if the rules
      allow that.
- [ ] Draft a post that is useful with no click: the substance first, then one link to the
      landing page (a users bet's path for a users bet). It says the founder made it.
- [ ] Hand it over as an ask_boss action: `action` names it ("Post the lease guide in
      r/<community>"), `instructions` say where, which rules apply and what to send back (the
      post's URL), `draft` is the text, ready to paste.
- [ ] Never: extra accounts, vote rings, the same post across many communities, mass DMs,
      reviews asked for or traded (a free copy for a review counts), friends posing as buyers.
- [ ] A buyer who praises it unprompted may be quoted only with their permission, which is
      the founder's to ask for.
- [ ] Once the page, the link and the post are all out, the lead calls measure_bet. Not
      before: a window over nothing shipped is a false verdict.

## 5. The portfolio effect

- Once one sells, the next in the same niche is cheaper: the buyer, the research and the
  channel carry over. Start it from the niche notes and the first product's reviews and
  questions.
- A second item on the same storefront is more of the same product: its own page, link and
  revenue bet (a product holds three live bets). A separate site is a new product, which only
  the lead makes.
- Cross-link: each landing page and each unlocked page points to the others. The page a buyer
  sees right after paying is where they are likeliest to buy the next one. A bundle is one
  more link at its own price.
- A sale counts only for the bet its link names, so a cross-sale through item A's link counts
  for A's bet.

## Optional: an Amazon KDP mirror, by the founder's hand

- Only once the direct page sells, and only if the founder wants it: KDP is their account and
  no tool reaches it. Its sales never reach Stripe, so no bet can count them. Never open a bet
  whose number would come from KDP.
- Hand it over as one ask_boss action: the manuscript and cover at KDP's current specs (read
  them on KDP's own help pages at the time), title, description, keywords, categories, price,
  and what to send back (the listing URL).
- The instructions must say: answer KDP's question about AI-generated content truthfully, and
  do not enrol the ebook in KDP Select, which requires the ebook be sold nowhere else,
  the product's own site included.
