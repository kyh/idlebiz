# idlebiz — the binary

One program, two kinds of verb, laid out as kyh/inteligir's `inteligir` is.

**`idlebiz serve` IS the game's server**, main: it owns the save under `~/.idlebiz`, the keys
and the runs, starts the employees' `claude` / `codex` sessions sealed, answers the company's
tools on the control plane, and serves the office page the window shows, on loopback. The
desktop shell runs it as its one child, on the node the .app ships, and speaks to it over its
stdio (`src/server/relay/`); nothing else in the repo runs a server. The server loads only for
`serve` (`src/commands/serve.ts`): its first import is its boot.

**Every other verb is a company tool**, which an employee types in its shell:

```sh
idlebiz read-team-chat
idlebiz message-team '{"text":"Shipped the pricing page."}'
idlebiz ask-boss - <<'EOF'
{"question":"Monthly or yearly plans? Can't pick without you."}
EOF
idlebiz ask-boss --help    # the tool's doc and an example
```

Each verb is a tool's name as a command-line word (`ask_boss` is accepted too), generated from
its spec in `src/server/tool-specs.ts`, so the instructions a run is given, the verb and the
server's parse cannot disagree (`src/commands/tools.ts`). It is a client of the control plane its
run was handed (`IDLEBIZ_API_URL`, `IDLEBIZ_RUN_TOKEN`, both run-scoped): it sends the request
as it is, on loopback alone and past any proxy, prints the answer, and exits 1 with why when the
call is refused or never arrives. Outside a run there is nothing to call, and it says so.

## How a run finds it

A Mac may have no node, and this package's bin finds one through `#!/usr/bin/env node`. So main
writes the runs a launcher at each boot (`src/server/agent-launcher.ts`): `~/.idlebiz/bin/idlebiz`,
a `sh` script that runs the node main runs on with the bundle main was started from, put first on
each run's PATH. No run writes it, since it sits outside every folder a run writes, and no
company is founded or loaded under its folder's name.

## Building it

`pnpm --filter idlebiz build` bundles `src/index.ts` into `dist/index.js` (Vite, its chunks flat
beside it, which `src/paths.ts` counts on), then stages the desktop page's build as `dist/page`
(`scripts/stage-page.ts`), which `serve` hands the window. Every dependency is bundled but
`sharp`, which is native, and the ACP adapters, which main runs as processes of their own: those
are this package's `dependencies`, and the .app ships them beside the bundle
(`apps/desktop/scripts/stage-server.ts`). Everything else is a `devDependency`.

`src/dev-host/` runs the built server as the shell runs it, answering its asks of a native app,
for `pnpm dev:browser` and the e2e suite.

## Testing it

`pnpm --filter idlebiz test` runs main's suites against temporary save roots and real loopback
servers, and the verbs against a live control plane. On macOS it also runs each run's seal and,
where a `claude` or `codex` CLI is installed, that CLI through the app's adapter against a
stand-in model (`src/server/agents/*-gate.test.ts`); those skip elsewhere.
