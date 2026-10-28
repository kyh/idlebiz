# How a product earns

Paths are short, as in [AGENTS.md](../AGENTS.md); the decisions behind it are `CLAUDE.md`'s.

`BUSINESS_MODELS` in `server/prompts/instructions.ts` tells each run how its type makes money with
the tools there are: software sells once through `create_payment_link`, a game studio a web
game's paid unlock, ecommerce prints through `sell_print` to US buyers or sells digital goods
through a link, custom whichever fits, and VC sells information only (deal memos, teardowns, a
paid newsletter). `instructions.ts` teaches the tools as one flow: an `ask_boss` action card for
any step only a human can take, `set_env` for a key the founder hands back, `sell_print` and
`read_orders` for prints, and a link's `delivery` for what the founder sends each buyer, never an
`ask_boss` card, which would block its bet. No prompt tells a run to push: the founder pushes by
hand (`instructions.test.ts` checks both).

**Checking who paid.** A product tells who paid on its own server (no tool makes a webhook): a
link's `afterPaymentUrl` sends each buyer back to a route of the product's with `session_id`, and
the route reads that checkout session with a restricted key of the product's own (Checkout
Sessions: Read, which the founder makes on an `ask_boss` action and the team keeps with
`set_env`), unlocking only a session `paid` on its link. It asks Stripe once per purchase, since
reads count against the founder's whole account, then trusts a cookie it signs with a secret of
its own; a session still `unpaid` (a bank debit clearing) is kept to check again, and a 429 or
5xx is never "not paid". A paid session id unlocks for whoever holds it, which the instructions
say, with how to tie a purchase to one buyer where the product has sign-in or a database. The
instructions teach it under "Checking who paid", with a Next.js route. What only the founder can
hand over, a link's `delivery` says, and the order pump cards the founder for each paid checkout
on it.

**Action cards.** `ask_boss` takes a question or an action (`{action, instructions, draft?}`): a
step no tool takes, such as posting from the founder's accounts, signing up, buying a domain or
verifying an email. The founder answers Done, with an optional note that reaches the run as
written (a product's own key included, by the founder's choice), or Can't, with why
(`resolveAction`). That note lands in the continuation's TASK.md, which every run can read, and
the card says so: sealing it elsewhere would narrow nothing while the runner's own transcript
holds the prompt. Only a run's first ask reaches the founder; every tool that asks says so when
its ask was dropped. The task blocks like a question's, so its bet gets no hands meanwhile.
TASK.md keeps an action behind `[action] ` as JSON, and escapes any question starting with `[` behind `[ask] `,
so no agent's text reads back as an action, an approval or a connect ask.
