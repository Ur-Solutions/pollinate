# pollinate

Standalone trigger substrate for schedules, event polls, and webhooks. It decides when
to fire and invokes a configured action; it does not reason or run agents in-process.

## Install

```sh
pnpm install
pnpm build
```

The package exposes both `pollinate` and `pol` when linked or installed:

```sh
pnpm link --global
pollinate --help
```

## Store

`POLLINATE_STORE_ROOT` controls the on-disk store. By default it is `~/.pollinate`:

```text
triggers/<id>.toml
state/schedule-state.json
state/delivery-state.json
state/cursors.json
state/job-id-index.json
jobs/<jobId>.json
ledger.jsonl
```

Job IDs follow the Honeybee-style shape `<trigger-prefix><uuid-prefix>`, for example
`HE.a3f`. The prefix is derived from the trigger ID, and the suffix is the shortest
globally unused UUID prefix with at least three alphanumeric characters. The backing
UUID is stored on the job and the index keeps suffixes from being reused over time.
Jobs can be addressed by the visible ID, by the visible suffix, or by a longer prefix
of the backing UUID.

## Basic Use

```sh
pollinate add ./trigger.toml
pollinate create hello --source manual --action command --command 'echo hello {{name}}' --static name=pollinate
pollinate list
pollinate trigger my-trigger --dry-run
pollinate trigger my-trigger --payload '{"source":"manual"}'
pollinate jobs --last 10
pollinate status
pollinate ledger -n 20
```

Run the daemon in the foreground:

```sh
pollinate daemon run --foreground
```

The daemon reloads trigger files automatically while running. Adding, editing,
enabling, disabling, or removing a trigger through the CLI is picked up without a
restart. The reload interval defaults to 1 second and can be changed in
`pollinate.toml`:

```toml
[defaults]
triggerReloadMs = 1000
```

Install it as a user service on macOS or Linux:

```sh
pollinate daemon install
pollinate daemon status
pollinate daemon logs
```

## Trigger Example

```toml
[trigger]
name = "morning-audit"
tags = ["audit"]
enabled = true
cwd = "/Users/me/src/pollinate"

[trigger.source]
kind = "schedule"
[trigger.source.timing]
type = "every"
interval = "1h"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 1

[trigger.context.static]
repo = "pollinate"

[trigger.action]
kind = "command"
command = "echo auditing {{repo}} from {{trigger_id}}"
timeout = "30s"
```

Supported action kinds are `command`, `http`, `honeybee`, `hermes`, and `emit`.
Supported delivery modes are `immediate`, `throttled`, `batched`, and `debounced`.

`cwd` is a trigger-level default working directory for command-backed work. Poll
command fetches, context command sources, command actions, Honeybee/Hermes CLI
actions, and queued jobs inherit it unless a lower-level `cwd` is set.

## CLI-Only Creation

You do not need to write TOML for common triggers:

```sh
pollinate create repo-changed \
  --source webhook \
  --path repo \
  --secret env:POLLINATE_REPO_SECRET \
  --delivery immediate \
  --max-concurrent 2 \
  --action emit \
  --subject repo.changed \
  --payload '{"repo":"{{repo}}"}' \
  --transform repo='$.repository.name'
```

Schedule example:

```sh
pollinate create hourly-audit \
  --source schedule \
  --every 1h \
  --cwd /Users/me/src/pollinate \
  --action command \
  --command 'echo auditing {{trigger_id}}'
```

For complex or less common shapes, use JSON escape hatches while still staying CLI-only:

```sh
pollinate create fanout \
  --source-json '{"kind":"webhook","webhook":{"path":"fanout"}}' \
  --delivery-json '{"mode":{"strategy":"debounced","quietPeriod":"30s"},"maxConcurrent":1}' \
  --action-json '{"kind":"emit","subject":"fanout.received","payload":"{{event}}"}'
```
