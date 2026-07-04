# AGENTS.md — operating pollinate

Pollinate is a standalone trigger substrate: schedules, polls, and webhooks fire
configured actions (shell commands, HTTP calls, hive/honeybee agent operations).
A router binds long-lived subjects (e.g. a GitHub PR) to long-lived agent
sessions. This file is the operating contract for agents driving pollinate —
everything here is otherwise only discoverable by reading the source.

## Quick facts

- Binaries: `pollinate` and `pol` (identical). Source of truth: `src/cli.ts`.
- Store root: `~/.pollinate`, overridable with `POLLINATE_STORE_ROOT`.
- Add `--json` to any command for machine-readable output. Errors with `--json`
  print `{"error": "..."}` to stderr and exit 1.
- Dev loop: `pnpm build` (tsc), `pnpm test` (build + vitest), `pnpm check`
  (build + test typecheck + lint + test).
- `pol add <file.toml>` and `pol create <id>` **overwrite** an existing trigger
  with the same id silently — check `pol get <id>` first if that matters.
- `--dry-run` exists on `pol trigger` and the `pol github …` commands only.

## Store layout

```text
~/.pollinate/
  triggers/<id>.toml              one trigger per file (0600)
  router-plugins/<name>.mjs       user-space router plugins
  state/schedule-state.json       next/last fire times
  state/delivery-state.json       throttle/batch/debounce queues
  state/cursors.json              poll cursors
  state/job-id-index.json         UUIDs used for visible job ID suffixes
  state/job-id-index.lock         lock for the job ID index
  state/trigger-locks/<id>.lock   per-trigger write locks
  state/job-locks/<jobId>.lock    per-job write locks
  state/router-bindings/<trigger>/<subject>.json   binding records
  state/router-bindings/<trigger>/<subject>.lock   binding write locks
  jobs/<jobId>.json               one job per execution
  ledger.jsonl                    append-only event log (the source of truth)
  daemon.log                      daemon lifecycle + GC log (pol daemon logs)
  daemon.out.log                  macOS launchd stdout log
  daemon.err.log                  macOS launchd stderr log
  pollinate.toml                  daemon config
```

## CLI map

| Command | Purpose |
|---|---|
| `pol add / create / list / get / enable / disable / edit / remove` | trigger CRUD; `edit` validates the TOML on editor exit |
| `pol trigger <id> [--payload '{…}'] [--dry-run]` | fire manually |
| `pol jobs / job <id> / job cancel <id>` | job inspection |
| `pol bindings [--trigger <id>] / bindings get <id>` | router binding inspection |
| `pol routers [list] / routers init <name>` | router plugin management |
| `pol hooks / hook create|inbox|wait|gc|test` | webhook endpoints, temporary hooks |
| `pol github create-pr-router / install-pr-router` | PR review router scaffolding + GitHub webhook install |
| `pol daemon install|uninstall|start|stop|restart|status|logs|run` | service management |
| `pol satellite run --target … --secret …` | public relay → local daemon |
| `pol status / ledger [-n N] [--follow]` | dashboard / event stream |

Answering "why didn't my trigger fire?": check `pol ledger -n 200` for
`delivery.filtered`, `router.open_filtered`, `webhook.rejected`,
`webhook.duplicate`, `router.unbound`, or `delivery.throttled` events, then
`pol daemon logs` for daemon lifecycle and binding-GC lines.

## Trigger TOML schema

Everything lives under `[trigger]`. camelCase and snake_case keys are both
accepted (`openOn` ≡ `open_on`).

```toml
[trigger]
id = "my-trigger"            # defaults to filename / slug of name
name = "my-trigger"
description = "optional"
cwd = "/path/for/commands"   # template-rendered; default cwd for actions
tags = ["github"]
enabled = true

[trigger.source]
kind = "schedule" | "poll" | "webhook" | "manual"

# kind = "schedule":
[trigger.source.timing]
type = "every" | "cron" | "once"
interval = "5m"              # every; durations: 500ms 30s 5m 2h 1d
expression = "0 8 * * 1-5"   # cron
timezone = "UTC"             # cron only
at = "2026-06-11T08:00:00Z"  # once
missedFirePolicy = "skip" | "fire-once" | "fire-all"

# kind = "poll":
[trigger.source.poll]
interval = "30s"
emit = "per-item" | "per-poll"
[trigger.source.poll.fetch]
kind = "command" | "http" | "file"   # command=…, url=…/method=…/headers, path=…
[trigger.source.poll.cursor]
strategy = "hash" | "append-offset" | "jsonpath"  # jsonpath = "$.items[*].id"

# kind = "webhook":
[trigger.source.webhook]
path = "github/myrepo/pr"    # served at /hook/<path>
secret = "env:HOOK_SECRET"   # literal or env:NAME; HMAC sha256 (sha1 for vercel)
[trigger.source.webhook.transform]   # optional jsonpath remap of the payload
title = "$.pull_request.title"

[trigger.filter]             # drop activations whose payload doesn't match
status = "done"              # equality (deep JSON compare)
agent = true                 # `true` means "key must exist"

[trigger.delivery]
mode = "immediate" | "throttled" | "batched" | "debounced"
maxConcurrent = 1
interval = "1m"              # throttled (+ collect = true to batch suppressed events)
window = "30s"               # batched
maxBatch = 10                # batched
quietPeriod = "20s"          # debounced

[trigger.context]            # extra template vars resolved before the action
[[trigger.context.sources]]
var = "diff"
kind = "command" | "http" | "file" | "honeybee"
command = "gh pr diff {{pr_number}}"
[trigger.context.static]
team = "platform"

[trigger.lifecycle]          # temporary hooks (pol hook create/inbox/wait)
temporary = true
expiresAt = "…"
maxDeliveries = 1

[trigger.action]             # required unless [trigger.router] is present
kind = "command" | "http" | "emit" | "hermes" | "honeybee" | "sequence"
```

### Action kinds

| kind | fields |
|---|---|
| `command` | `command`, `cwd?`, `timeout?` — runs through the configured shell |
| `http` | `method`, `url`, `headers?`, `body?`, `timeout?` |
| `emit` | `subject`, `payload?` — appends a ledger event only |
| `hermes` | `invoke` (name or URL), `payload?`, `timeout?` |
| `honeybee` | `run = "spawn"\|"send"\|"buz"\|"kill"\|"flow"\|"loop"` (below) |
| `sequence` | `mode = "serial"\|"parallel"`, `primary?`, `continueOnError?`, `actions = [{id, action}]` |

Honeybee runs (executed argv-style, never through a shell — payload text cannot
inject commands):

- `spawn`: `bee` (required), `name?`, `colony?`, `home?`, `cwd?`, `yolo?`,
  `acceptTrust?`, `args?` (passed after `--`), `message?` (sent after spawn),
  `timeout?`. The spawn result handle must match `^[A-Za-z0-9._:-]+$`; garbage
  hive output fails the action loudly instead of binding silently.
- `send`: `target`, `message`, `timeout?`
- `buz`: `target`, `message`, `tier = "interrupt"|"queue"|"passive"`,
  `subject?`, `senderHuman?` (default `pollinate`), `timeout?`
- `kill`: `target`, `timeout?`
- `flow`: `flow`, `args?` (map → `--arg k=v`)
- `loop`: `loop` table (flags passed to `hive loop start`)

### Router triggers

```toml
[trigger.router]
plugin = "github-pr"         # built-in, or a name in ~/.pollinate/router-plugins/
openOn  = ["github.pull_request.opened", "github.pull_request.reopened"]
closeOn = ["github.pull_request.closed", "github.pull_request.merged"]
idleTtl = "48h"              # GC closes bindings idle longer than this
[trigger.router.openWhen]    # same filter semantics, applied to the open event payload
pr_author = "trmdy"
[trigger.router.onOpen]      # action; its handle becomes binding.target
[trigger.router.onActivity]  # action; runs for every non-open/non-close event
[trigger.router.onClose]     # optional; defaults to honeybee kill {{binding.target}}
```

Binding lifecycle: `pending → active → closing → closed`, with `errored` on
onOpen failure. Open events on an existing active binding ledger
`router.already_bound` and do not respawn. Activity failures (e.g. `hive send`
to a dead session) record `error` on the binding and ledger
`router.activity_errored` — the binding stays active and later activity retries.

The daemon GC sweeps bindings every `defaults.bindingGcMs` (default 60s):

- **idleTtl** — active bindings idle past `idleTtl` are closed via onClose.
- **errored retry** — errored bindings are re-opened from the stored open
  context, up to 3 attempts, then abandoned (ledger `binding_expired`,
  reason `open-retries-exhausted`).
- **stale pending** — pending bindings older than 10 min (daemon died mid-open)
  are marked errored so the retry pass re-drives them.
- **reconciliation** — for plugins exporting `subjectState` (built-in
  `github-pr` shells out to `gh pr view --json state`), active bindings quiet
  for 5+ min are checked; closed/merged subjects are closed via onClose
  (ledger `binding_reconciled`).

### Router plugin contract (`pol routers init <name>`)

```js
export default {
  name: "my-plugin",
  // Map a webhook delivery to zero or more canonical events.
  normalize({ headers, body, path }) {
    return [{ subjectKey: "my:subject#1", kind: "my.opened", payload: { …, activity_markdown: "…" } }];
  },
  // Optional: "open" | "closed" | "unknown" — enables GC reconciliation.
  async subjectState(subjectKey, { cwd, execution }) { return "unknown"; },
};
```

## Template variables

`{{var}}` placeholders render in action strings, keys, and `cwd`. Unresolved
vars stay literal and surface as job warnings.

Plain (non-router) actions:

| var | value |
|---|---|
| `trigger_id`, `source_kind`, `fired_at` | activation metadata |
| `event` | JSON of the (transformed) payload |
| `batch`, `batch_count` | JSON array of batched payloads / count |
| `<context vars>` | from `[trigger.context]` static + sources |

Router actions (onOpen / onActivity / onClose) get the canonical event payload
plus:

| var | value |
|---|---|
| `event_kind`, `subject_key`, `binding_id` | routing metadata |
| `binding.target` (and `target`) | bound hive handle |
| `binding.targets.<stepId>` | per-step handles for sequence/swarm onOpen |

`github-pr` payload fields: `provider`, `repo`, `repo_owner`, `repo_name`,
`repo_slug`, `pr_number`, `pr_url`, `pr_title`, `pr_state`, `pr_author`,
`action`, `actor`, `merged`, `activity_markdown` (ready-to-send summary),
`activity_url`, `comment_body`, `review_body`, `review_state`, `file_path`,
`line`, `check_name`, `check_status`, `check_conclusion`. Event kinds follow
`github.<webhook_event>.<action>`, with `github.pull_request.merged` synthesized
when a close has `merged: true`.

## Loop prevention contract

Bees that post PR comments **must** include `<!-- pollinate-router -->` at the
top of the comment. The `github-pr` plugin drops comments containing that
marker, which is the only thing preventing a bee's own comment from re-waking
it. Keep review bees read-only (`--allowedTools` with `gh pr view/diff/comment`,
`Read`, `Grep`, …) — comment bodies are untrusted prompt input.

## Webhooks

- Local endpoint: `POST /hook/<path>` on `127.0.0.1:3978` (configurable via
  `[webhook]` in `pollinate.toml`; `publicUrl` powers printed URLs).
- Signatures: `x-hub-signature-256` / `x-pollinate-signature` / `x-signature`
  (HMAC-SHA256 hex), or `x-vercel-signature` (SHA1). No secret ⇒ any POST fires.
- Rejected signatures ledger `pollinate.webhook.rejected` with a `reason`.
- Redeliveries: repeats of `x-github-delivery` per trigger are accepted with
  `{duplicate: true}` but not dispatched (ledger `pollinate.webhook.duplicate`).
  The cache is in-memory; a daemon restart forgets old GUIDs.
- Relay: `pol satellite run` on a public host forwards `/hook/*` to the local
  daemon's `/relay/*` with a timestamped HMAC (`[webhook.relay] secret`).

## Daemon config (`~/.pollinate/pollinate.toml`)

```toml
[webhook]
bind = "127.0.0.1"
port = 3978
publicUrl = "https://hooks.example.com"
[webhook.relay]
secret = "env:RELAY_SECRET"
maxAgeSeconds = 300

[defaults]
contextTimeout = "5s"
commandTimeout = "10m"
tickMs = 1000
triggerReloadMs = 1000
bindingGcMs = 60000          # router binding GC sweep interval

[execution]                  # shell profile for command actions / polls
shell = "/bin/sh"
shellArgs = ["-c"]
inheritEnv = true
[execution.env]
PATH = "…"
```

## Ledger events

Append-only JSONL at `~/.pollinate/ledger.jsonl`; every entry has `ts` and
`event`. Stream with `pol ledger --follow`.

- `pollinate.trigger.{added,enabled,disabled,removed}`
- `pollinate.job.{queued,started,completed,errored,cancelled}`
- `pollinate.delivery.{filtered,throttled}`
- `pollinate.schedule.{fired,missed}` · `pollinate.poll.{checked,detected,errored}`
- `pollinate.webhook.{received,rejected,duplicate}`
- `pollinate.hook.{created,delivered,expired,gc_removed}`
- `pollinate.router.{binding_pending,binding_created,binding_routed,binding_closed,binding_errored,binding_retry,binding_expired,binding_reconciled,already_bound,unbound,open_filtered,activity_errored,gc}`
- `pollinate.router.plugin.created` · `pollinate.github.webhook.installed`
- `pollinate.daemon.{started,stopped,triggers_reloaded,reload_errored}`
- `pollinate.emit` (from `emit` actions)

## Job IDs

Jobs use Honeybee-style IDs `<TRIGGER-PREFIX>.<uuid-prefix>` (e.g. `HE.a3f`).
`pol job <ref>` accepts the visible id, the suffix, or a longer UUID prefix.
Terminal statuses: `completed`, `errored`, `timed-out`, `cancelled`.
