# PR Router Setup

Pollinate routers are for workflows where one external subject should map to one
long-lived target. A GitHub pull request is the first built-in example: the first
PR event spawns a bee, later PR activity is delivered to that same bee, and PR
closure cleans the bee up.

The core router implementation is provider-neutral. Provider-specific code lives
in router plugins, which only normalize raw webhook payloads into canonical
events.

## Mental Model

A router trigger has four moving parts:

- A normal Pollinate webhook source receives provider payloads.
- A router plugin converts each payload into canonical events with a stable
  `subjectKey`, an event `kind`, and template payload fields.
- Pollinate stores the runtime binding from `triggerId + subjectKey` to a target
  handle.
- Router actions define what to do on open, activity, and close.

The binding is not hand-written in TOML. It is created automatically when an
incoming event kind matches `openOn`.

For GitHub PRs, the built-in `github-pr` plugin creates subject keys like:

```text
github:pull_request:Ur-Solutions/pollinate#2
```

Pollinate then stores the resulting binding under:

```text
~/.pollinate/state/router-bindings/<trigger-id>/<safe-subject-key>.json
```

## Binding Lifecycle

1. GitHub sends a webhook to `/hook/<path>`.
2. Pollinate finds the matching trigger and queues a normal job.
3. The router plugin normalizes the raw webhook.
4. If the event kind is in `openOn`, Pollinate locks the subject key and runs
   `trigger.router.onOpen`.
5. For a Honeybee spawn action, Pollinate captures the spawned hive handle and
   saves an active binding.
6. Later activity for the same subject key loads the active binding and renders
   `trigger.router.onActivity` with `{{binding.target}}`.
7. If the event kind is in `closeOn`, Pollinate renders `trigger.router.onClose`
   and marks the binding closed after the action succeeds.

That is the entire correlation mechanism. The plugin decides "this event belongs
to PR #2"; Pollinate decides "PR #2 currently maps to bee X".

## GitHub PR Trigger

The quickest setup is the built-in creator:

```sh
pollinate github create-pr-router pollinate-pr-router \
  --repo Ur-Solutions/pollinate \
  --cwd /Users/me/src/pollinate \
  --secret env:GITHUB_WEBHOOK_SECRET \
  --base-url https://hooks.example.com \
  --install-webhook
```

That writes the trigger and, when `--install-webhook` is present, creates or
updates the GitHub repository webhook through `gh api`.

Use repeated `--reviewer id=bee` flags to create a swarm-style router:

```sh
pollinate github create-pr-router pollinate-pr-router \
  --repo Ur-Solutions/pollinate \
  --cwd /Users/me/src/pollinate \
  --secret env:GITHUB_WEBHOOK_SECRET \
  --reviewer claude=claude \
  --reviewer grok=grok
```

Pollinate stores each spawned handle under `binding.target.handles`, so later
activity can address `{{binding.targets.claude}}` and `{{binding.targets.grok}}`.

Manual trigger setup is also supported. Create a trigger file such as:

```text
~/.pollinate/triggers/pollinate-pr-router.toml
```

Example:

```toml
[trigger]
id = "pollinate-pr-router"
name = "Pollinate PR router"
enabled = true
cwd = "/Users/me/src/pollinate"

[trigger.source]
kind = "webhook"
[trigger.source.webhook]
path = "github/pr"
secret = "env:GITHUB_WEBHOOK_SECRET"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 4

[trigger.router]
plugin = "github-pr"
openOn = [
  "github.pull_request.opened",
  "github.pull_request.reopened",
  "github.pull_request.ready_for_review",
]
closeOn = [
  "github.pull_request.closed",
  "github.pull_request.merged",
]

[trigger.router.activityWhen]
event_kind = "github.pull_request.synchronize"

[trigger.router.onOpen]
kind = "honeybee"
run = "spawn"
bee = "codex"
name = "pollinate-pr-{{pr_number}}"
cwd = "/Users/me/src/{{repo_name}}"
args = [
  "--allowedTools",
  "Bash(gh pr view *),Bash(gh pr diff *),Bash(gh pr comment *),Read,Grep,Glob,LS",
]
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

Start Pollinate:

```sh
pollinate daemon run --foreground
```

Then point GitHub at the public URL for the trigger:

```text
https://<public-host>/hook/github/pr
```

Use `application/json`, configure the same secret as
`GITHUB_WEBHOOK_SECRET`, and subscribe to these event families:

```text
pull_request
issue_comment
pull_request_review
pull_request_review_comment
check_run
check_suite
```

Only issue comments that belong to pull requests are routed. Plain issue comments
are ignored by the `github-pr` plugin.

You can install or update the GitHub webhook for an existing trigger with:

```sh
pollinate github install-pr-router pollinate-pr-router \
  --repo Ur-Solutions/pollinate \
  --base-url https://hooks.example.com
```

The command uses the trigger's webhook path and secret. If the trigger secret is
`env:GITHUB_WEBHOOK_SECRET`, that environment variable must be set when installing
the provider webhook.

Use `--dry-run` to inspect the request without calling `gh api`.

## Activity Delivery

Use `honeybee` `run = "send"` when the bee must react to new PR activity as a
normal prompt.

`run = "buz"` is still available for addressed messages, but queue/passive buz
delivery depends on Hive delivery policy and daemon behavior. It is not the
right default for an automated review loop that should wake the target bee on
each comment, review, or commit-related event.

## Loop Prevention

Router-controlled bees that post PR comments should include this hidden marker:

```text
<!-- pollinate-router -->
```

The `github-pr` plugin ignores issue comments and review comments containing
that marker, which prevents a bee's own PR comment from being routed back into
the same bee.

## Template Fields

The `github-pr` plugin exposes these common fields to router actions:

```text
repo
repo_owner
repo_name
repo_slug
pr_number
pr_url
pr_title
pr_state
event_kind
action
actor
activity_markdown
activity_url
comment_body
review_body
review_state
check_name
check_status
check_conclusion
```

Not every field exists on every event. For example, `comment_body` only exists on
comment events, while check fields only exist on check events.

Pollinate also adds binding fields when rendering router actions:

```text
binding_id
target
binding.target
subject_key
```

`{{binding.target}}` is the usual field for `onActivity` and `onClose`.

For sequence/swarm router actions, Pollinate also exposes one field per named
target:

```text
binding.targets.<id>
```

Example:

```toml
[trigger.router.onActivity]
kind = "sequence"
mode = "parallel"
primary = "claude"

[[trigger.router.onActivity.actions]]
id = "claude"
kind = "honeybee"
run = "send"
target = "{{binding.targets.claude}}"
message = "{{activity_markdown}}"

[[trigger.router.onActivity.actions]]
id = "grok"
kind = "honeybee"
run = "send"
target = "{{binding.targets.grok}}"
message = "{{activity_markdown}}"
```

`sequence` actions can be `serial` or `parallel`. When sequence steps produce
Hive handles, Pollinate records them by step id and uses `primary` as the
default `{{binding.target}}`.

## Observability

List active or historical bindings:

```sh
pollinate bindings
pollinate bindings --trigger pollinate-pr-router
pollinate bindings get <binding-id>
```

Inspect Pollinate routing and job proof:

```sh
pollinate ledger -n 100
rg 'pollinate-pr-2|binding_created|binding_routed|binding_closed' ~/.pollinate/ledger.jsonl
rg 'pollinate-pr-2|github:pull_request' ~/.pollinate/jobs
```

Inspect Hive lifecycle proof:

```sh
rg 'pollinate-pr-2|session.save|prompt.send|session.kill' ~/.hive/ledger.jsonl
```

Provider-side proof should still be checked at the provider. For GitHub:

```sh
gh pr view 2 --repo Ur-Solutions/pollinate --json number,state,url,comments
```

## Adding Another Router Plugin

Routers can be implemented as user-space plugins when TOML configuration is not
expressive enough.

Create a plugin scaffold:

```sh
pollinate routers init linear-review
pollinate routers list
```

This writes:

```text
~/.pollinate/router-plugins/linear-review.mjs
```

1. Add a plugin that implements `RouterPlugin` from `src/router-plugins/github-pr.ts`.
2. Normalize provider payloads into `CanonicalRouterEvent` values.
3. Use a stable subject key that names the external thing being followed.
4. Reference it by name in TOML with `plugin = "linear-review"`.
5. Add tests for normalization, open/activity routing, close cleanup, and any
   self-output ignore markers.

The router core does not need provider-specific code for new providers. Only the
plugin needs to know how that provider names subjects and event kinds.

Plugins may export `default`, `routerPlugin`, or `plugin`:

```js
export default {
  name: "linear-review",
  normalize(input) {
    return [{
      subjectKey: "linear:issue:" + input.body.issue.id,
      kind: "linear.issue.commented",
      payload: {
        event_kind: "linear.issue.commented",
        activity_markdown: input.body.comment.body,
      },
    }];
  },
};
```
