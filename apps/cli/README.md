# idlebiz — the binary

One program, two kinds of verb.

**`idlebiz serve` IS the game's server**, main: it owns the save under `~/.idlebiz`, the keys
and the runs, starts the employees' `claude` / `codex` sessions sealed, answers the company's
tools on the control plane, and serves the office page the window shows, on loopback. The
desktop shell runs it as its one child and speaks to it over its stdio (`src/server/relay/`);
nothing else in the repo runs a server. The server loads only for `serve`
(`src/commands/serve.ts`): its first import is its boot.

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
its spec in `src/server/tool-specs.ts` (`src/commands/tools.ts`).

The rest is told once, in the repo's [AGENTS.md](../../AGENTS.md):

- the verb as a client of its run's control plane, its exit codes and the launcher main writes
  each run: [The store and the company's tools](../../AGENTS.md#the-store-and-the-companys-tools);
- the build (`pnpm --filter idlebiz build`) and `src/dev-host/`: [Map](../../AGENTS.md#map);
- what the .app ships of this package, and why only the ACP adapters are `dependencies`:
  [Packaging and release](../../AGENTS.md#packaging-and-release);
- the suites (`pnpm --filter idlebiz test`), the seal's and the gates' on macOS among them:
  [Tests](../../AGENTS.md#tests).
