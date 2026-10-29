# Runs

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions.

## A run's env, login and notes

- **Env.** A run starts from the founder's (main's) env less every credential-shaped name —
  `TOKEN`, `SECRET`, `PASSWORD`, `KEY`, `APIKEY`, `PAT`, `DSN`, `WEBHOOK`, `CREDENTIALS`, `AUTH` as
  whole `_` segments, so `SSH_AUTH_SOCK` too — and every URL with a login in it but a `*_PROXY`,
  except its runner's own login (`providerEnv` in `packages/agent-driver/src/registry.ts`;
  `runEnv` in `server/agents/run-env.ts`). AWS access keys sign for the whole account, so neither
  runner keeps them, and the seal hides `~/.aws` (`LOGINS` in `machine-seal.ts`), so no AWS profile loads
  either: a founder on Bedrock signs in with `AWS_BEARER_TOKEN_BEDROCK` only. On Vertex,
  `GOOGLE_APPLICATION_CREDENTIALS` must name a key file outside the sealed logins: gcloud's
  default credentials under `~/.config/gcloud` are hidden too.
- **A claude session** loads no setting source (`settingSources: []`,
  `packages/agent-driver/src/registry.ts`): not the founder's user settings (their CLAUDE.md and
  rules, skills, plugins, hooks, permissions), nor a project's or a local one, which a run could
  otherwise write for the next to load. What remains is managed policy and the flag tier its session
  options set: claude's own sandbox off, ask rules for shell and edits, no bypass mode, no plan mode
  (its exit asks to approve a plan, which would block the task on a founder card that changes
  nothing), no skills of claude's own (`disableBundledSkills`), IdleBiz's as a plugin, and none of
  their MCP servers or claude.ai connectors (`strictMcpConfig`, `disableClaudeAiConnectors`, a deny
  of `mcp__*`), which act signed in as the founder; the company is reached with the `idlebiz`
  command ([The store and the company's tools](save.md#the-store-and-the-companys-tools)). A sign-in
  kept in their settings rather than their shell still reaches the run (`claudeUserSettings` in
  `server/agents/claude-user-settings.ts`): their settings' `env` (a Bedrock or Vertex switch, a
  gateway's URL and token), through `runEnv` as the shell's env goes, filtered alike, and the
  helpers claude runs for a key or a cloud login (`apiKeyHelper`, `awsAuthRefresh`,
  `awsCredentialExport`, `gcpAuthRefresh`), which run sealed, so one that reads `~/.aws` or gcloud's
  login fails as it did. So does the model they picked, with its effort (`model`, `effortLevel`,
  `modelSettings`, `alwaysThinkingEnabled`, `modelOverrides`), in the flag tier: claude would
  otherwise run its default, and claude-agent-acp, which reads their user settings, sets a model
  only when it thinks claude picked another. A deny rule in managed settings outranks the flag
  tier's ask rules and would refuse a company tool's `idlebiz` command before IdleBiz is asked, the
  turn still ending as done, so a claude run under one does not start, and says which rule
  (`refuseDeniedTools` in `server/agents/claude-denies.ts`).
- **A codex session** loads the founder's codex config with every MCP server turned off by the
  name `codex mcp list` gives it, and apps, plugins and memories whole (`codexSessionEnv` in
  `server/agents/session.ts`): turning plugins off is also what keeps their plugins' skills out.
  One it cannot list refuses the run with codex's reason. No codex setting leaves all the
  founder's own skills out, nor their instructions or rules, so the seal keeps a codex run from
  reading them (their memories too), and IdleBiz's folder is handed to the session to read
  (`readDirs`). The codex gate test plants each of these and checks none reaches the model, and
  that a push their rules allow still asks.
- **Team notes.** A product's notes for teammates are `AGENTS.md` at its workspace's root, for
  both runners: codex reads it itself, and a claude session, which loads no project's CLAUDE.md,
  is handed it beside its system prompt (`systemPrompt.append` in its session `_meta`), read by
  main as the run starts (`readTeamNotes` in `server/agents/team-notes.ts`), framed as the team's
  notes, never the founder's word (`server/prompts/team-notes.ts`), and cut at 32 KiB, before a
  character the cut would split. Main picks it as codex does, `AGENTS.override.md` in its place
  when there is one, and codex's session config pins what their config could change
  (`project_doc_fallback_filenames` empty, `project_doc_max_bytes` at the same 32 KiB), so both
  runners read the same notes. Main reads it unsealed, so only a file of the workspace's own root:
  through a link only to a file beside it (the common `AGENTS.md` -> `CLAUDE.md`), never one
  leading further, where a folder on the way could turn into a link between resolving and opening,
  and never a hard link. The standing instructions say it is the team's word, not the founder's,
  and have every teammate keep it as a plain file, fold an override into it and leave a CLAUDE.md
  as `@AGENTS.md`, which the founder's own claude follows.
- **Signed in.** A runner is signed in only if its login probe, run sealed as its runs are, says
  so: a codex login kept in the Keychain reads as none (a codex run reaches no Keychain), and
  onboarding's sign-in says to keep it in a file. The work of a runner not signed in waits on the
  queue, spending no attempt (`signedIn` in `server/agents/runner-pool.ts`), until a sign-in finds
  it again. A turn whose login the provider refused (a revoked token, `claude auth logout`
  mid-session) reads the runner as signed out the same way (`heed`) until the founder signs it in
  again, however often its probe, which reads only the login stored, says signed in: the sign-in
  runs its login for it anyway. With no CLI left the gate asks for that sign-in; with another
  still signed in the HUD names each signed-out runner someone works on and who waits on it, the
  lead's steering included, beside a Sign in button.
- **Failures and rests.** A failed turn is classed by what its adapter says before its prose
  (`packages/agent-driver/src/rate-limit.ts`: claude's `errorKind`, codex's typed failure's
  category and actions; claude's kinds mirror claude-agent-acp's `providerFailureCategory`). The
  package reports only the class and, for a usage limit, when the provider said it lifts; what
  each costs the runner is decided in one place, `heed` in `server/agents/runner-pool.ts`:
  - `auth` signs the runner out as above.
  - `usage-limit` (a rate limit, billing, an account on hold) rests it until the reset the
    provider reported (claude's `_claude/rateLimit` on usage updates, in epoch seconds; codex-acp
    keeps its rate limits to itself, so its text) or else the time its text names, never past 12h.
    claude-agent-acp forwards that rate limit only once the turn has had a model response, so a
    turn refused on its first request, as a retried task's usually is, names a reset only in its
    text; one naming none rests the runner 30m, since a retry refused again costs one spawn and no
    tokens.
  - `overloaded` rests it 1m, doubling with each one in a row up to 15m (`backoffMs`) and starting
    over once a turn ends any other way, since a busy provider clears in minutes.
  - `access-denied` (an organization yet to verify, a Bedrock/Vertex/Foundry credential claude
    could not load) neither signs it out nor spends the session, since signing in again cannot
    repair it, but rests it on the same backoff, so a credential blip clears and a standing
    refusal is not hammered, and #team tells the founder what the provider said.
  - `context` spends the session. A turn stopped at the output cap (claude's `max_tokens` stop
    reason, as its `max_output_tokens` errorKind) is one, never a finished turn: its work is cut
    off.

  A rest never shortens one holding, and is kept in `state/runner-rest.json`, so a restart does
  not spawn each parked task once to be refused; it is not critical: lost, that is all it costs.

## Skills

IdleBiz's skills live at `apps/cli/resources/skills/.agents/skills/<name>/SKILL.md` (Agent Skills format: frontmatter
`name` and `description`, then the body), shipped in the .app with the server
(`apps/desktop/scripts/stage-server.ts` stages the `idlebiz` package, `resources/` and all) and
found by `bundledSkillsDir` (`server/agents/bundled-skills.ts`) beside the server that runs. The
hidden `.agents` is forced: codex-acp takes skills only from `<folder>/.agents/skills` of a folder
a session is handed, and `.agents` is also the claude plugin `idlebiz`
(`.agents/.claude-plugin/plugin.json`), whose skills folder is the same one; claude names each
`idlebiz:<name>`. Adding one is adding its folder there; the gate tests prove both runners are
offered each one shipped. No `allowed-tools` and no `!` shell lines in a SKILL.md
(`bundled-skills.test.ts` holds each to that, and to a `name` matching its folder). The first,
`digital-product`, is the playbook for selling a guide, template or unlock direct, through the
product's own page and create_payment_link, so a bet counts each sale.
