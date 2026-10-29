# Keys and what spends them

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions.

**Keys.** The keys IdleBiz holds live in `~/.idlebiz/secrets.json`, which the seal keeps from
every run. They are IdleBiz's own: main reads each where it uses it (`getSecret` in
`server/secrets.ts`) and exports none into any env, so no employee holds `STRIPE_SECRET_KEY` or
`VERCEL_TOKEN`. A key is named only by its constant there, or by a set_env value's `ENV/` name,
so a misspelt name fails typecheck rather than reading as no key.

- Each value is also sealed with a key the macOS Keychain keeps for IdleBiz (service "IdleBiz",
  account "sealing-key": 32 random bytes, base64, made on the first launch that finds none,
  `src-tauri/src/keychain.rs`), since a claude run can still reach the Keychain. The shell reads
  it with no prompt, being the signed app that made it, and hands it main at hello as
  `sealingKey`; main never reaches the Keychain. It seals with AES-256-GCM, a random nonce and the
  key's name as associated data, as `sealed:v2:<base64 of nonce, ciphertext and tag>`
  (`sealerFor` in `server/secrets.ts`, `setSealer` at boot).
- Keys are entered in the app: `VERCEL_TOKEN` through a product's Vercel button (under users),
  Stripe and Printful in the Budget panel (under revenue). A key pasted into the file as plain
  text is sealed the next time main reads it. One main can't open (another build or another
  scheme sealed it, a byte of it changed, it was moved under another name, or access was denied)
  reads as absent, is named in Settings and stays as it is: enter it again. A `secrets.json` that
  fails to parse is listed in Settings and never rewritten (`readJsonFileForUpdate` in
  `server/lib/fs.ts`).
- Dev (any unpackaged launch, e2e too) seals with a fixed key, `DEV_SECRETS_KEY`: a development
  shell is ad-hoc signed, so the real Keychain would ask again after every rebuild and stall
  automation. It never touches the Keychain: a key dev sealed is no secret and only dev opens it.
  On the real save (no `IDLEBIZ_ROOT_DIR`) dev seals nothing, so it strands none: the packaged
  app's keys read as absent there and one entered there is written plain for the app to seal. Use
  `IDLEBIZ_ROOT_DIR`.
- Those keys never reach a run by the founder's hand either: no run reaches the pasteboard a key
  is pasted through ([A run's seal](seal.md#a-runs-seal)), and an action's reply, a question's
  answer, a room message and an order card's note holding one are refused (`refuseHeldKey` in
  `server/company-actions.ts`; an order card's also refuses anything shaped like a Stripe key),
  and so is `set_env` given one. Both also refuse any Stripe secret key (`sk_`,
  `holdsStripeSecretKey`), IdleBiz's or not: it charges, refunds and pays out on the whole account
  with no sign-off, so a Stripe key the team asks for is a restricted one. What a restricted key
  was granted no API reads, so an `rk_` passes on the founder's word.

**Signed tools.** An outward step that needs a key is a signed tool main runs: `deploy`,
`create_payment_link` and `sell_print`. Each runs once the founder signs off on the action it
names, which is the approval's key (`requireSignOff` in `server/tools/define.ts`); a sign-off
belongs to the continuation task, is spent once and goes with the task. A sign-off pins an action,
not the tree a deploy ships, and runs on one product share its workspace, so a run carrying one
has that workspace to itself: the scheduler's `tick` starts it only once no other run is live
there, and starts nobody new there while it waits or runs. The agents are told the folder is
shared. No tool sets a project's domains or sells a subscription: those stay the founder's.

**Vercel and `deploy`.** `deploy` uploads the product's folder through Vercel's API with the
founder's `VERCEL_TOKEN` (`server/deploy.ts`), and Vercel builds it on its own machines. The
action signed is `deploy <product> to production on Vercel project <name>` (or
`on a new Vercel project named <product>` for a product bound to none).

- Before the sign-off is asked, and before `set_env` sets anything, Vercel is asked whether it
  still takes the token (`validateToken`): one it turns away (expired, revoked) leaves the founder
  a Vercel card rather than spend the sign-off on a call that would fail.
- The deploy never runs the Vercel CLI, which runs code a folder holds (`vercel.ts`, a `vercel`
  npx finds first, what a repo's config tells git to run) with the token in its env. Main only
  reads the files, a symlink as the path it holds (as the CLI uploads it), never what it names.
  Main names the project too: the bound one, or for an unbound product a new one named after it,
  bound as soon as Vercel makes it; a name another project holds asks the founder to bind instead.
  So no file in the folder (`.vercel/project.json`, a `name` in vercel.json) picks which of the
  founder's projects is overwritten.
- One `VERCEL_TOKEN` serves every product: binding another reuses it unless the founder pastes a
  new one. Each product binds a project of its own (a project another product holds is refused).
  The first token saved, through any product, resumes every Vercel ask, since it is what each
  product's deploy lacked; after that a binding resumes only the Vercel asks about that product or
  about none: an ask names the product it is about (`productId`, saved as the task's
  `askProduct`), which a run may name other than its own, and its Inbox card opens that product's
  binding. A refused token shows on each bound product as "vercel refused".

**`set_env` and the deploy's key scan.** `set_env` sets a variable on the product's bound project,
sensitive, for production and preview (`server/vercel-env.ts`), unsigned, since a key the founder
handed back for that product has reached runs anyway: their reply sits in the task.

- It only creates a name set_env never set there, and replaces only one it did: the founder may
  bind a live project whose variables are theirs, and a sensitive one cannot be read back. Nothing
  is retried as a readable type.
- Main keeps each value Vercel took in `secrets.json` (`ENV/<product>/<project>/<NAME>`, per
  project, so a product rebound to a project of the founder's replaces none of theirs; main's own
  copy never in the save, which runs read).
- A deploy refuses a folder any of whose uploaded files holds one, from any product, or any key
  IdleBiz itself holds (`heldKeys` in `server/secrets.ts`), naming the file and the variable or
  key, never the value: a key in source ships publicly. It reads the folder for that before it
  asks for the sign-off, and again over what it uploads. Only values of 8 characters or more are
  scanned. It is a tripwire, not a boundary: an encoded or split key passes, and nothing scans
  what the founder pushes by hand.
- Vercel's own names are refused as a name (`server/env-name.ts`). A name with a prefix a
  framework builds into the page (`NEXT_PUBLIC_`, `VITE_`…) is set, so a publishable key (`pk_`)
  stays out of the source, but never over a value shaped like a secret (`publicValueRefusal`:
  Stripe's `sk_`/`rk_`/`whsec_`, a private key block, GitHub, OpenAI, Anthropic, AWS, Resend and
  Slack keys), nor over one set_env keeps under a server-only name, or one holding or held in it
  (`serverOnlyValueIn`): the build inlines a public value where the file scan never looks. The
  deploy guard skips a public name's value (`unshippableEnvValues`), which the build ships anyway;
  that trusts the name, not the framework, so a prefix the product's framework does not read
  (`VITE_` in a Next.js app) leaves a value server-only and unguarded.
- A set_env call's title, its command line, is logged as `set_env` alone, judged on the whole
  title before the log cuts any title to one short line (`loggedToolName`, `scheduler.ts`): a
  command may put the value before the verb.

**Stripe and `create_payment_link`.** `create_payment_link` prices in USD and makes a Stripe
payment link with the founder's own key (`server/stripe-links.ts`), tagging each payment for its
product and a named revenue bet on it, open or measuring, and the link alone with the `delivery`
its buyers are owed, which Stripe copies onto each checkout. It keeps each link it makes under
`links/`. The action signed is `payment link "<name>" at $<amount> on <product> for bet <slug>
delivering "<delivery>" then send buyers to <url>`: the delivery is what the founder owes each
buyer and the URL is where paying buyers land, so a changed one is signed anew.

- Each POST goes under an idempotency key of its fields, like `sell_print`'s, so a retry after a
  timeout gets back the link Stripe made rather than a second one nothing saved knows; Stripe
  replays a failure (a 500 too) for a day, so a key it answered with one moves on to the next
  (`idempotentPost`), as does a replayed link Stripe now lists as switched off (a reset, a
  retirement or the founder switched it off since). A replayed link Stripe won't look up counts
  as on and is read like any create's answer, since Stripe made it either way: recorded, or named
  to the agent as one that may stand, never as no link made.
- Before the sign-off it asks Stripe whether the key still reads payment links
  (`stripeLinkAccess`), so a key rolled, revoked or expired since it was saved leaves a Stripe
  card instead of spending a sign-off on a call that would fail; one Stripe turns away while making
  the link or a listing's (401/403) leaves the same card. A link with a `delivery` is refused
  before the sign-off while the key cannot read checkout sessions (`stripeCheckoutAccess`), since
  that read is how each buyer reaches the founder.
- Its optional `afterPaymentUrl`, where each buyer lands once they have paid, must be https with
  no login or port on one of the product's verified production domains (`productionHosts` in
  `server/vercel.ts`, as `sell_print`'s files), and main adds
  `session_id={CHECKOUT_SESSION_ID}`, which Stripe fills (`after_completion[type]=redirect`).
- With no key it leaves the founder a Stripe card that opens the Budget panel, whose charging-key
  row saves a key only once Stripe has taken it (`server/stripe-key.ts`) and resumes the work that
  waited on it: every Stripe card is one `stripe` ask, a key to charge with or to count revenue
  with alike, and none resumes on a test-mode key, which counts no money unless
  `IDLEBIZ_COUNT_TEST_MONEY=1`. A new key is pasted over the saved one, never after removing it: a
  pulse between the two finds no key and hands each retiring link to the founder to switch off by
  hand.
- A restricted key needs Write on Payment Links, Prices and Products to charge, Read on Charges
  for the revenue read and for each paid print, whose payment the order pump reads before Printful
  is paid, Read on Checkout Sessions for the order pump and a link's `delivery`, and Write on
  Shipping Rates to sell a print, which `sell_print` checks with a read of all three
  (`stripeListingAccess`) before it asks for the sign-off.
- Metrics reads revenue with the same key (`stripeCredential` in `server/metrics.ts`), since every
  payment link and so every tagged charge is on its account; with no key saved nothing reads
  revenue. A key Stripe turns away on that read stays saved and shows in the Budget panel as
  refused (`noteStripeRead` and `stripeKeyStatus` in `server/stripe-key.ts`, asked again on each
  pulse) until a read Stripe takes, or a key pasted over it. That may be the same key: a
  restricted key's grants are edited in place, so saving one drops the read kept of it
  (`forgetStripeRead`) and the pulse it starts asks Stripe again.
- Stripe's and Printful's calls run through `answering` (`server/lib/vendor-call.ts`), all but the
  revenue read (`metrics.ts`, which settles each read apart) and the Printful token's check: it
  sorts how a call failed and reports an answer its schema refuses once, under the call's name,
  and each caller folds that into its own result.

**Printful and `sell_print`.** `sell_print` lists a Printful print-on-demand item
(`server/print-listing.ts`). Agents find variant ids, placements and techniques with
`printful_catalog` (`printfulCatalog` in `server/printful.ts`), which main reads with the token
(v2 serves the catalog only to a signed-in caller). The action signed is `sell "<name>" (variants
<ids>) printing <placement> (<technique>) <file URL> sha256:<digest> at $<price> via Printful on
<product> for bet <slug>`, the file's whole digest, so a design deployed over the URL is signed
for anew.

- Its print files must be images the product's own verified production domains serve now, each
  read whole and hashed (`readPrintFile`). Printful's estimate prices each variant with them at
  the listing's price (California taxes that, not Printful's own) to Los Angeles, Seattle, Denver
  (Colorado adds a retail delivery fee), Alaska and Hawaii (`server/printful.ts`, polled every 3s
  and backing off on a 429), and a price below the floor is refused before the founder is asked
  (`priceFloorCents`: the dearest estimate plus Stripe's 4.4% + 30¢ at its dearest, less the
  shipping the buyer pays), as is a Stripe key that cannot read shipping rates, checkout sessions
  or charges.
- Signed, it makes a Stripe price, a fixed shipping rate at Printful's dearest shipping and a
  card-only payment link collecting US addresses only, a dropdown for the variant when there are
  several, tagged like `create_payment_link`'s and with `metadata[listing]`, each POST under an
  idempotency key of its fields (`stripeShippedLink` in `server/stripe-links.ts`), and saves the
  listing under `listings/` with each file's sha256 and whether its link is live.
- The Printful token and its one store are the founder's, pasted in the Budget panel and kept only
  once Printful shows it can place orders in exactly one store (`server/printful-token.ts`). The
  store is no secret, so it sits in `printful-store.json` beside `secrets.json`, written before
  the token and put back as it was if the token can't be kept: neither is kept without the other.
  With no token, or one Printful refuses, the tool leaves a Printful card that opens that panel,
  where a new token is pasted over the saved one.

**The order pump** (`server/order-pump.ts`) runs on the metrics pulse and sends each paid order to
Printful unsigned, since the founder signed the listing and its price floor. Its tests fake
Stripe, the product's site and Printful at `fetch` (`server/order-pump.test.ts`).

- While a Stripe key is saved, every 30 minutes it makes one account-wide read of Stripe's
  checkout sessions (`server/order-intake.ts`, through `server/stripe-checkouts.ts`, line items
  expanded; a list per link, or a faster beat, would spend the reads Stripe allows, which metrics
  already mostly spends on a quiet store) from a `created[gt]` cursor in
  `state/orders-cursor.json`, one per key that has read (named by its mode and a digest, never the
  key), since a key of another mode or account lists none of this one's sessions: a key new to a
  mode already read starts from the oldest of that mode's cursors, one of a mode never read from
  the founding. Each is held behind any checkout that may still be paid and re-reads the last 10
  minutes. A read that cannot reach the cursor (Stripe lists newest first) moves it up to what it
  read and cards the founder.
- A session on a listing's link with `payment_status` `paid` (complete alone is not paid) is kept
  as an order under `orders/`, on disk before Printful hears of it; its Printful `external_id` is
  the session id's hash, looked up (`/v2/orders/@<id>`) before a draft is made
  (`server/printful-orders.ts`), so a restart never makes one twice. The design is read again and
  must hash as signed.
- A draft charges nothing; it is polled every pulse until priced (a bounded number of reads) and
  confirmed only on a read that shows it still a draft costing no more than Stripe collected less
  its dearest fee on a card (`netOfStripeCents`), with the payment's charges read just before,
  neither refunded nor disputed and paid by card (`readPaymentStanding`, Read on Charges, whose
  refusal cards the founder at once; IdleBiz makes a listing's link take only cards, but the link
  can be widened on Stripe's side after, to Klarna or Affirm, whose fee is dearer), so no restart
  confirms twice or past that guard. A send whose last try failed asks Printful once more for a
  draft it may have made before the founder is told to place it by hand. Waiting orders are sent
  and sent ones' Printful status read every 10 minutes.
- A test-mode sale is priced, then its draft deleted (one Printful never prices is deleted too),
  and anything that stops it goes to the room, never a card: nobody paid.
- A paid session on a `create_payment_link` link (its `product` tag names a product of the
  company, live or retired, and it has no `metadata[listing]`) is kept as a `link` order and
  posted to the room, and a live one whose link names a `delivery` is carded to the founder with
  the buyer's email and that text: nothing else reaches a buyer. One tagged with a listing this
  save no longer holds is kept as an unreadable order and carded. A card is raised before its
  order is kept, since cards dedupe by subject and the kept order is what stops the next read
  retrying.
- What the pump cannot settle (a draft dearer than the payment less the fee, a refunded or
  disputed payment, a changed design, a refusal, a status of failed, canceled or onhold the first
  time any call reads it, a refused key once anything is sold) is an order card in the Inbox: a
  blocked task of origin `order` naming its subject (`OrderCardSubject` in `@repo/domain/domain`:
  an order and its trouble, a link left on, or what stops the pump), which dedupes it and settles
  it, its title only copy rendered from it; no assignee, no product, so no bet stalls, no
  retirement drops it and no teammate can claim it. The founder's Done or Can't closes it with no
  run, as `settled` history (`settleOrderCard` in `server/company-actions.ts`), and goes to the
  room, where support reads it. Refunds are the founder's, in Stripe, and each card says so. A
  menu-bar-only launch counts what waits on the founder in the tray and notifies each new order
  card.
- Agents read orders, buyers' emails and addresses included, with the unsigned `read_orders`.

**Retiring a product** switches off, in main with the founder's key, every payment link it sells
through, a listing's and each `create_payment_link` link, whose record main keeps under `links/`
(`switchOffRetiredLinks` in `server/company-actions.ts`, run by the retirement and every pulse,
which sends `POST /v1/payment_links/<id>` with `active=false`; `server/retired-links.test.ts`), so
it takes no new money; checkouts already paid still count and still ship, and one opened before
the switch and paid after is kept like any other.

- Only a product whose package is under `retired/` and not `products/` counts as retired
  (`isRetiredProduct`), so one boot could not read keeps its links, and its paid checkouts are
  still kept as orders (`madeProduct`).
- The retirement is on disk before Stripe is asked and never depends on its answer; each link
  then records `switched-off`, `retrying` while Stripe is busy (429), failing (5xx) or out of
  reach, or `left-on` with why, raised first as one card per link naming it to switch off by hand
  in Stripe's dashboard (no key, a refusal, ten sweeps unanswered; a test-mode link tells the room
  instead), whose Done records it switched off by the founder. A key saved but not openable this
  launch leaves the links waiting for it.
- Every pulse sweeps again, one sweep at a time and one link at a time, so a quit before Stripe
  answered is finished at the next launch; switching off a link already off answers the same. A
  link Stripe makes while its product retires is still kept, and switched off at once.
  `read_orders` and `kill_product` say where each of a retired product's links stands.

**A reset** waits for each signed link Stripe is still making to be recorded and refuses a new one
(`makingPaymentLink`), then switches off every live link not yet off before it deletes the save
(`switchOffBeforeReset` in `server/reset-links.ts`), since nothing is left after to ship its prints or record a buyer. Its
warning names each link Stripe left on, each paid print Printful never confirmed (but a held one
whose card the founder settled), and each paid order whose card still waits on the founder (a
delivery, one IdleBiz cannot send).

**Nothing pushes code.** The founder pushes by hand from a fresh clone
(`git clone --no-local <workspace>`), never with git inside the workspace: the seal keeps a run
from git's config and hooks there, but git still obeys what a run leaves in the folder (a rebase's
todo list, a `.gitattributes`), unsealed, as the founder. A clone runs only upload-pack there,
which runs nothing its config names since git stopped lazy-fetching a partial clone's missing
objects (2.45.1; 2.39.4 and the other backports). The prompts and the questions IdleBiz asks the
founder say so. A shell `git push` is still held under `git-push`, and signed it runs as any
command does: on a claude run git reaches a credential helper that reads the Keychain (gh's), so
it can push over https as the founder. Refuse it.
