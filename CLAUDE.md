# CLAUDE.md

Read **AGENTS.md** first — it is the operating contract for this project:
trigger TOML schema, template variables, router binding lifecycle and GC,
ledger event types, webhook signature/dedup behavior, and the
`<!-- pollinate-router -->` loop-prevention marker.

## Development

- `pnpm build` — TypeScript compile (tsc, ESM, Node ≥ 20)
- `pnpm test` — vitest run
- `pnpm check` — build + test; run this before declaring work done

## Code conventions

- Two runtime dependencies (`smol-toml`, `jsonpath-plus`) — keep it that way;
  prefer the standard library over new packages.
- Tests live in `tests/*.test.ts` and use the helpers in `tests/helpers.ts`
  (`withTempStore`, `trigger`, `installHiveStub`, `waitForTerminalJobs`) rather
  than hand-rolled PATH stubs or temp stores.
- Hive/hermes invocations go through `execArgv` (no shell). Only `command`
  actions and the configured execution profile use `execShell`. Never
  interpolate webhook-derived text into a shell string.
- TOML config accepts both camelCase and snake_case keys; preserve that in
  `src/config.ts` when adding fields, and document new fields in AGENTS.md.
- New ledger event names follow `pollinate.<area>.<verb>` and must be added to
  the AGENTS.md ledger list.
