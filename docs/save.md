# The save and the store

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions.

## The save

Game state lives on disk at `~/.idlebiz/company/`, beside `cache/` (the runs' tool caches) and
`bin/` (the `idlebiz` command main writes the runs at boot), as agentcompanies/v1 markdown
packages, laid out file by file at the top of `server/paths.ts`. Beyond the layout:

- An employee's `AGENTS.md` frontmatter is the employee, its body a mirror of the instructions
  each run is given, rendered live and rewritten at boot.
- Every product has a package, the first included, with its code in
  `products/<slug>/workspace/` (placed by the slug alone, so retiring it moves one folder), whose
  root `AGENTS.md` is the team's notes on it.
- `listings/`, `links/` and `orders/` sit outside every product's package, so all outlive its
  retirement: its links are switched off from them, and each order still ships or is still owed.
  Runs read them, never write them.

A root holds one save or none: `company/`, a fixed folder founding publishes with one rename and
boot reads alone (`server/paths.ts`), so no record carries a company id and no path names one.
Its paths are read when asked for, never at import, and refused until a save is open: serve opens
its launch's (`IDLEBIZ_ROOT_DIR`, or `~/.idlebiz`) first, a test its own. Founding refuses while
it exists, and one boot cannot read (its COMPANY.md missing or refused) blocks the office like a
save of another format. A reset deletes the whole root, `secrets.json` included; to start over
otherwise, move `company/` out.

Every file main writes lands whole, a tmp file renamed over it (`lib/fs.ts`), so no reader sees
half of one. COMPANY.md, `approvals.json`, `secrets.json` and every file founding stages are also
on the disk before the rename (`durable`), so an OS crash or a power cut leaves the old file or
the new one, never an empty one; any other file a crash empties is a package the load report
names, or state its next write replaces.

COMPANY.md carries `format` (`SAVE_FORMAT`, `store/company-codec.ts`), and a save stamped at any
other blocks loading and founding (`SaveFormatError`). Each codec reads its kind through one
strict zod schema, the one its encoder writes to: a package it refuses (a hand edit, a field
missing) is skipped and named in the load report, never read with a default, and so is an
`approvals.json` that does not parse, which no sign-off then writes over. Frontmatter is read as
YAML reads it or not at all (`store/frontmatter.ts`): a value is null, a boolean, a number, one
JSON string or plain text, and a line beyond that (single quotes, a block, a trailing comment, an
indented line outside `metadata:`) refuses its package, naming the line, rather than load a value
nobody wrote. A frontmatter key the app does not know is still dropped on the next write of that
file. Boot alone repairs what a hand edit or a release with no lead leaves (`initStore`): a run
that names no lock is queued again, and queued or running work nobody holds is to do. No repair
stands in for a package it skipped: a lead whose AGENTS.md did not read stays lead, and a
teammate's open work stays theirs.

Only closed work is history. `done` tasks move to `shipped/` and load on demand; so does an ask
the founder answered, `superseded` by its continuation, an order card the founder `settled`, and
work the steering loop `dropped` (its bet stopped taking work, its product was retired, its
assignee released), none ever a ship. `dead` tasks — runs that failed on their own — stay in the
active queue until their bet stops or their product retires, because the Inbox can retry them and
employees use them to identify unresolved problems. `listOpenTasks` answers open work only; the
one reader of history is `shippingLog`, which sends each ship as a line without its brief.

One main holds a save at a time. Boot claims it before it reads it (`server/save-claim.ts`: a
socket main listens on in `<save>/.main/` while it runs, which a second main on that save finds
answering), so a main on a save another holds (`pnpm dev:desktop` while the installed app has
`~/.idlebiz` open) refuses to boot and says so, rather than run each task twice; one a crash left
holds nothing. Each main's socket has a name of its own that appears only once it answers, so a
file there that answers nothing never will and any main clears it, and mains claiming at once
each step back a random while and try again, so one holds and never two. A
second launch of the packaged app hands over to the first, which shows its window
(`tauri-plugin-single-instance`, `src-tauri/src/lib.rs`); a development shell skips it, since it
keys on the bundle id machine-wide and would hand over to an installed IdleBiz.

## Activity and running state

`publishActivity` (`server/activity.ts`) stamps, persists and fans out one `ActivityEvent`
(`@repo/domain/activity`, a discriminated union on `kind` with typed payloads). Consumers switch
on `kind`; nobody re-parses a payload.

State that outlives a run is written where it is known: the founder's digest folds into
`state/since-last-look.json` as each event publishes (`store.logActivity`,
`server/store/digest.ts`), and what a run leaves for the next — the session to resume and a
digest of the instructions it holds, where the real numbers stood, what they last shipped — sits
in `agents/<slug>/run-state.json`, so AGENTS.md changes only when the instructions do. A resumed
session is sent them again only when that digest no longer matches. The brief's "recently
shipped" lines come from `state/recent-ships.json`, written with the ship. Nothing reads
`activity.jsonl` back: main appends to it and pushes each event to the renderer, whose activity
ring starts empty every launch; #team reads the room back from main's copy of `chat.jsonl`
instead.

## The store and the company's tools

The store (`store/store.ts`) holds the one company this launch runs, so nothing in its API takes
a company id: `getCompany()` is null before one is founded, and everything else throws "no
company is loaded" — a caller that can run without one (tray, boot, the pulse) asks first.
Lookups (`getX`) return null, `requireX` and commands throw, and null otherwise means only that a
claim or lock race was lost. A few reads and notes are safe with none: `listQueuedTasks` and
`openTasksFor` answer none, `logActivity` numbers its event for the renderer and records nothing,
and `noteRunEnd` and `releaseListingId` note nothing. It refuses with a `RefusalError`
(`server/refusal.ts`) worded as the sentence the agent should read; a tool turns that into its
answer, refused, the page's API into the founder's note. Anything else thrown is a fault:
answered the same way, as a fault, but reported to main's log.

A company tool is described once, in `server/tool-specs.ts`: body, lead-only refusal, doc and
example. The agents' instructions are rendered from it, `server/tools/` binds each implementation
to its spec (`define`), `idlebiz <tool>` is the client a run types it with (`commands/tools.ts`),
and `control-plane.ts` is only transport, which serves each tool at its name alone (`toolPath`:
posted to `/v1/<tool_name>` on the run's socket), so `callTool` takes a `ToolName` and what it
answers is shaped once (`ToolAnswerSchema`) for both ends.

- Main writes a launcher at each boot (`server/agent-launcher.ts`, `~/.idlebiz/bin/idlebiz`), since
  a Mac may have no node for the package's `#!/usr/bin/env node` bin: a `sh` script that runs the
  bundle main was started from on main's own node, first on each run's PATH, outside every folder a
  run writes. The verb sends its request to the control plane its run was handed
  (`IDLEBIZ_API_SOCKET`, `IDLEBIZ_RUN_TOKEN`), over that run's own unix socket only
  ([A run's seal](seal.md#a-runs-seal) says why the socket names the caller). `-` reads the request
  from stdin, and `idlebiz <tool> --help` prints the tool's doc. It sends the request as its
  shortest JSON (`encodeRequest`), however the agent spaced or escaped it: that is what the control
  plane's 64 KiB limit weighs and set_env's 60 KiB value limit counts, so a value set_env takes fits
  in a call.
- Every call ends in one of `TOOL_OUTCOMES`, the verb's exit code, which the instructions render:
  done (0) is what the implementation returns, refused (1) a `RefusalError` or the lead-only
  refusal, a fault (2) anything else thrown, reported to main's log, and held (4) a call waiting
  on the founder (a sign-off, an integration: `holdOnFounder` in `server/tools/define.ts`). An ask
  that did not reach the founder is refused; `ask_boss` and `request_integration`, whose call is
  the ask, are done once it does. The verb prints the answer on stdout whichever it is, so
  `idlebiz deploy && …` stops at a deploy awaiting sign-off. A call that never reached main, or
  that main could not take (a body that does not parse), exits 1 with why on stderr. Outside a run
  there is nothing to call, and it says so.
- A change everyone should hear about (a bet, a product, autopilot) goes through
  `server/company-actions.ts`, whoever made it: a tool, the scheduler or the founder's page. Its
  `postToRoom` is the team room's only writer, and names the speaker (founder, office or
  employee).
- What the founder hands the team (a room message, a direct request, an answer, a sign-off, an
  assignment, a connection resuming the asks it answers) is `server/founder-actions.ts`, which
  files and queues through the scheduler's `file` and `enqueue`. The scheduler keeps the tick,
  admission, autopilot and the runs, and is handed at boot the integrations a run's tools call out
  with (`Integrations` in `server/tools/define.ts`), so tests fake them: `unaskedIntegrations`
  (`server/test-support/integrations.ts`) fails every call a test does not override.
