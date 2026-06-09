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
router-plugins/<name>.mjs
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

## Execution Profile

Commands run by pollinate can use a configured shell and environment. This applies to
poll command fetches, context command sources, and command/honeybee/hermes actions:

```toml
[execution]
shell = "/bin/zsh"
shellArgs = ["-lc"]
inheritEnv = true

[execution.env]
PATH = "/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

Use a controlled `PATH` here instead of relying on an interactive terminal startup file.
That keeps JSON-producing poll commands predictable while still giving jobs access to
tools such as `gh`, `hive`, `node`, and `claude`.

Install it as a user service on macOS or Linux:

```sh
pollinate daemon install
pollinate daemon status
pollinate daemon logs
```

## Webhook Satellites

If you do not want public webhooks to hit your workstation directly, run the local
daemon on loopback and put a stateless satellite on a VPS. The satellite receives
public `/hook/<path>` requests, forwards the raw body and provider signature headers
to the local daemon's `/relay/<path>` endpoint, and signs that relay hop with a
separate Pollinate HMAC.

Local daemon config:

```toml
[webhook]
bind = "127.0.0.1"
port = 3978
publicUrl = "https://vps.example.com"

[webhook.relay]
secret = "env:POLLINATE_RELAY_SECRET"
maxAgeSeconds = 300
```

Recommended: expose the local loopback daemon privately over Tailscale Serve, then
run the satellite on the VPS with its target set to the workstation's tailnet name or
Tailscale IP. This does not require any inbound workstation port or a long-running SSH
session:

```sh
# Workstation. Keeps pollinate itself bound to 127.0.0.1.
tailscale serve --bg --tcp=3978 tcp://127.0.0.1:3978
```

Then run the satellite on the VPS:

```sh
POLLINATE_RELAY_SECRET='same-secret-as-local' \
pollinate satellite run \
  --bind 0.0.0.0 \
  --port 3979 \
  --target http://workstation-name:3978 \
  --secret env:POLLINATE_RELAY_SECRET
```

If you do not want to use Tailscale Serve, bind the local daemon to its Tailscale IP
instead and point the satellite at `http://100.x.y.z:3978`. Use Tailscale ACLs so only
the satellite node can reach that port.

Fallback without Tailscale is an outbound reverse SSH tunnel from the workstation to
the VPS:

```sh
ssh -N -R 127.0.0.1:3978:127.0.0.1:3978 user@vps.example.com
```

Point providers at `https://vps.example.com/hook/<path>`. Existing webhook trigger
secrets still validate provider signatures on the local daemon; the relay secret only
authenticates the satellite-to-daemon hop.

## Temporary Webhook Hooks

Long-lived provider webhooks are just regular webhook triggers created with
`pollinate create --source webhook`. For short-lived callbacks, Pollinate can create
temporary webhook triggers with random routes, TTLs, and delivery limits:

```sh
pollinate hook create callback \
  --ttl 15m \
  --once \
  --action emit \
  --subject callback.received
```

If `[webhook].publicUrl` is configured, the command prints a full public URL such as
`https://vps.example.com/hook/tmp/<token>`. Otherwise use `--base-url`:

```sh
pollinate hook create callback --ttl 15m --once --base-url https://hooks.example.com
```

Common patterns are available directly:

```sh
pollinate hook inbox --ttl 1h
pollinate hook wait --ttl 10m
pollinate hook gc
```

`hook inbox` creates a temporary webhook that emits the received payload.
`hook wait` creates a one-shot webhook, prints the URL, waits for the first delivery,
then removes the trigger. `hook gc` removes expired or spent temporary hooks; the
daemon also runs this cleanup on start and trigger reload.

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

## Router Triggers

Router triggers correlate many incoming events to one long-lived target. The
first in-tree router plugin is `github-pr`: it normalizes GitHub PR webhooks into
a stable subject key such as `github:pull_request:owner/repo#123`. Pollinate owns
the binding state and target lifecycle; router plugins only normalize payloads.
See [docs/pr-router.md](docs/pr-router.md) for the full GitHub PR review setup,
binding lifecycle, and verification commands.

The fastest path for GitHub PR review automation is:

```sh
pollinate github create-pr-router pollinate-pr-router \
  --repo Ur-Solutions/pollinate \
  --cwd /Users/me/src/pollinate \
  --secret env:GITHUB_WEBHOOK_SECRET \
  --base-url https://hooks.example.com \
  --install-webhook
```

User-space router plugins can be scaffolded with `pollinate routers init <name>`.
Pollinate loads built-ins by name and local modules from
`~/.pollinate/router-plugins/<name>.mjs`.

```toml
[trigger]
id = "github-pr-events"
name = "GitHub PR events"
enabled = true

[trigger.source]
kind = "webhook"
[trigger.source.webhook]
path = "github/pr-events"
secret = "env:GITHUB_WEBHOOK_SECRET"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 4

[trigger.router]
plugin = "github-pr"
openOn = ["github.pull_request.opened", "github.pull_request.reopened", "github.pull_request.ready_for_review"]
closeOn = ["github.pull_request.closed", "github.pull_request.merged"]

[trigger.router.onOpen]
kind = "honeybee"
run = "spawn"
bee = "codex"
name = "pr-{{repo_slug}}-{{pr_number}}"
cwd = "/Users/me/src/{{repo_name}}"
args = ["--allowedTools", "Bash(gh pr view *),Bash(gh pr diff *),Bash(gh pr comment *),Read,Grep,Glob,LS"]
message = "Review PR {{repo}}#{{pr_number}}: {{pr_title}}. If you post a PR comment, include <!-- pollinate-router --> at the top."

[trigger.router.onActivity]
kind = "honeybee"
run = "send"
target = "{{binding.target}}"
message = "New PR activity for {{repo}}#{{pr_number}}:\n\n{{activity_markdown}}\n\nIf you post a PR comment, include <!-- pollinate-router --> at the top."

[trigger.router.onClose]
kind = "honeybee"
run = "kill"
target = "{{binding.target}}"
```

Inspect runtime subject-to-target bindings with:

```sh
pollinate bindings
pollinate bindings get <binding-id>
pollinate routers list
```

Use `honeybee` `run = "send"` for activity that must wake the target bee and
be handled as a normal prompt. `run = "buz"` is useful for addressed messaging,
but queue/passive tiers depend on Hive buz delivery policy and daemon behavior;
they are not a substitute for direct prompt delivery when the router is expected
to make the bee react immediately. GitHub comments containing
`<!-- pollinate-router -->` are ignored by the `github-pr` router plugin; include
that hidden marker in PR comments posted by router-controlled bees to avoid
routing their own output back into the same target.

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

## Poll Visibility

Every successful poll writes a `pollinate.poll.checked` ledger event:

```json
{"event":"pollinate.poll.checked","trigger_id":"example","item_count":2,"new_count":0}
```

When `new_count` is greater than zero, pollinate also emits `pollinate.poll.detected`
and dispatches jobs according to the trigger delivery policy.
