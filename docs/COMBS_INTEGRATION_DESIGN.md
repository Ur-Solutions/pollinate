# Pollinate ↔ Honeybee Combs integration design

**Status:** v2-reconstructed (2026-07-28) — rebuilt from the canonical engine contracts and the original revision's seal record; supersedes the stranded working-tree copy unless that copy resurfaces and is diffed against this.

**Owners:** Pollinate owns trigger intake, delivery durability, router bindings,
external observations, and coverage references. Honeybee owns the Comb registry,
runs, claims, subscriptions, graph ordering, evidence, and cancellation.

**Canonical contract:** `honeybee/docs/COMBS_ENGINE_DESIGN.md`. In particular,
its §§2.7, 5.1–5.4, and 9.7–9.11 are normative for every cross-process shape in
this document. `apiary/docs/COMBS_CONTRACT_RECONCILIATION.md` §§1–2 establishes
that ownership rule. If this document disagrees with either, the engine design
wins.

## Reconstruction boundary

The completed v2 revision was never committed and is not reachable from this
machine. This reconstruction uses:

- the canonical engine contract;
- the cross-system reconciliation index;
- the consolidated design review that assigned C1, C3, C13, S7, and C17 to
  Pollinate;
- the original v1 and v2 Honeybee seal records; and
- this checkout's current implementation.

The recovered v2 seal says the lost revision contained: JSON-stdin input
mapping with whole-string typed JSON coercion; envelope-based run-id parsing;
a persistent per-subject run-delivery retry queue with bounded exponential
backoff swept on the binding-GC cadence; JSONPath subject-revision extraction;
additive GitHub `pr_head_sha`/`head_sha` fields; literal Comb names; 19 explicit
engine-alignment points for C2/C4/C5/C10/C16/S10; owner-scoped coverage; and
the shared golden-contract corpus. Those elements are preserved here.

This is primarily a staged design, not a blanket claim of landed behavior. The
pinned Comb action is implemented by the action slice; run targets, the
delivery outbox, observation specs, and coverage remain later slices. The
evidence for each extension point is cited below.

### Action-slice pre-verification (2026-07-28)

The action slice was checked against Honeybee commit `969cb27b` and the
executable `contracts/combs/v1/cli-golden.json` corpus before implementation:

- `hive comb run` now requires the exact flag `--product <key>`. Its CLI error
  states that strict-spine slice 1 never infers product identity from cwd.
  Pollinate therefore requires a literal `product` action field and never uses
  `basename(cwd)`.
- Honeybee's run-graph retry defaults are exactly
  `retryBackoffMs=5_000` and `retryBackoffMaxMs=300_000`. They are engine
  activation-policy constants, not Pollinate action retry timers. This slice
  only classifies process failures and canonical exit 7 as retryable; the
  durable-transport slice still owns its outbox timing constants.
- Honeybee's delivery replay index is exactly
  `~/.hive/combs/deliveries/<sha256-of-delivery-id>.json`, with adjacent lock
  `~/.hive/combs/deliveries/.<sha256-of-delivery-id>.lock`. Pollinate creates
  no parallel replay store in the action slice; it supplies a stable
  provider-qualified delivery ID and trusts the engine index.
- Revision-bearing observations remain mandatory before mutation:
  `comb observe` requires `--subject-rev`, and instantiation rejects missing
  subject revisions. GitHub activities such as issue comments that lack a
  head SHA cannot become revision-sensitive observations. This is irrelevant
  to the action slice because observations and run-event delivery are out of
  scope.
- The current strict-spine engine explicitly rejects `--event-json` because
  subscriptions are disabled. The action maps the Pollinate event through
  `input` and passes only `--origin-trigger`/`--origin-delivery`. Event
  transport stays disabled until its engine seam exists.

## 1. Data model

### 1.1 Existing extension points

Pollinate already has a recursive JSON value type (`src/types.ts:1-3`), a
discriminated Honeybee action union (`src/types.ts:58-77`), recursive sequence
actions (`src/types.ts:79-90`), and jobs whose `result` may hold an external
back-reference (`src/types.ts:148-164`). Configuration normalizes every
Honeybee run mode in one switch (`src/config.ts:328-419`), while execution
dispatches them from one switch and invokes `hive` argv-style
(`src/actions.ts:253-323`). The additions below extend those seams rather than
create a parallel action system.

### 1.2 Public Comb action and internal transport leaves

Only `run: "comb"` is author-facing trigger configuration:

```ts
export type CombRunAction = {
  kind: "honeybee";
  run: "comb";
  comb: string; // literal registry name; never rendered
  version: number; // required positive immutable registry version
  product: string; // literal explicit engine product key; never inferred
  input: JsonObject;
  collision?: "refuse" | "join-existing";
};

export type HoneybeeAction =
  | ExistingHoneybeeAction
  | CombRunAction;
```

This is the exact logical action shape owned by the engine contract §9.7.
`comb` or `product` containing `{{` or `}}` is rejected during normalization,
and `version` must be a safe positive integer. The generic renderer currently
renders every string in an action (`src/templates.ts:67-100`), so the Comb
renderer must treat `comb`, `product`, and `version` as immutable control
fields rather than ordinary templates. That is the Pollinate half of C17 and
the immutable-version half of S5.

Event and observation delivery are internal outbox operations, not extra
author-authored Honeybee action modes:

```ts
export type CombTransportOperation =
  | {
      kind: "run";
      comb: string;
      version: number;
      input: JsonValue;
      cwd: string;
      productKey: string;
      collision?: "refuse" | "join-existing";
      event: RoutedRunEvent;
    }
  | {
      kind: "event";
      runId: string;
      event: RoutedRunEvent;
    }
  | {
      kind: "observe";
      observation: ObservationPayload;
    };
```

Keeping transport leaves internal prevents hand-authored triggers from
supplying fake provenance, source order, or causation. All three leaves use
`execArgv`, whose current implementation passes argv without a shell and
supports exact stdin bytes (`src/process.ts:29-40`,
`src/process.ts:43-73`).

### 1.3 Typed input mapping

`CombRunAction.input` is rendered recursively. Literal JSON values retain their
types. A string which consists of exactly one template placeholder receives
whole-string JSON coercion:

```ts
const WHOLE_TEMPLATE = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

function renderCombInput(value: JsonValue, vars: Record<string, unknown>): JsonValue {
  if (Array.isArray(value)) return value.map((item) => renderCombInput(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderCombInput(item, vars)]),
    );
  }
  if (typeof value !== "string") return value;

  const match = WHOLE_TEMPLATE.exec(value);
  if (!match) return renderRequiredString(value, vars);
  if (!Object.prototype.hasOwnProperty.call(vars, match[1]!)) {
    throw new Error(`Unresolved Comb input template var: ${match[1]}`);
  }
  const rendered = stringifyTemplateValue(vars[match[1]!]);
  try {
    return JSON.parse(rendered) as JsonValue;
  } catch {
    return rendered;
  }
}
```

Examples:

| Authored input leaf | Context value | Result |
|---|---:|---:|
| `"{{pr_number}}"` | `"421"` | `421` |
| `"{{merged}}"` | `"true"` | `true` |
| `"{{event}}"` | `"{\"repo\":\"trmd/pollinate\"}"` | `{ "repo": "trmd/pollinate" }` |
| `"PR-{{pr_number}}"` | `"421"` | `"PR-421"` |
| `"{{repo}}"` | `"trmd/pollinate"` | `"trmd/pollinate"` |

This deliberately builds on `stringifyTemplateValue` and `renderString`
(`src/templates.ts:11-27`), and on recursive JSON rendering
(`src/templates.ts:41-65`). Unlike normal action warnings, an unresolved
placeholder anywhere in a Comb input is fatal before the outbox write. The
engine must never receive a literal `{{missing}}` as apparently valid input.

### 1.4 Router binding target generalization

The current binding target can represent only a Hive handle
(`src/types.ts:185-211`). It becomes:

```ts
export type RouterBindingTarget =
  | {
      kind: "hive";
      handle: string;
      handles?: Record<string, string>;
    }
  | {
      kind: "run";
      runId: string;
    };

export type BindingOwner = {
  owner: string;
  idempotencyKey: string;
  registeredAt: string;
};

export type RouterBinding = {
  // Existing identity/lifecycle fields remain.
  id: string;
  triggerId: string;
  router: string;
  subjectKey: string;
  subjectKind?: string;
  eventKinds?: string[];
  status: RouterBindingStatus;
  target?: RouterBindingTarget;
  owners?: BindingOwner[];
  lastSubjectRevision?: string;
  // Existing timestamps, error, context, attempts, checkedAt remain.
};
```

`ActionResult` adds `targetKind?: "hive" | "run"`. A successful Comb action
returns the run ID in `handle` plus `targetKind: "run"` so the current router
open path can thread run-ness through the same result seam it already uses for
spawn handles (`src/actions.ts:15`, `src/router.ts:125-150`). Sequence results
propagate the `targetKind` of their configured `primary` step; an ambiguous
sequence without a primary run target is rejected rather than guessed.

Persisted v1 targets normalize as `{kind:"hive",handle,...}`. Runtime code must
switch on `target.kind`; it must not continue reading `target.handle`
unconditionally as current routing, ledgering, rendering, and close code do
(`src/router.ts:68-77`, `src/router.ts:175-238`,
`src/router.ts:241-255`).

The current store keys one binding file and one lock by
`(triggerId,subjectKey)` (`src/store.ts:76-82`,
`src/store.ts:235-247`). The lock remains the subject serialization boundary,
but the directory must support multiple binding IDs because independently
owned run subscriptions may share a subject. Pattern-A router bindings and
pattern-B engine registrations converge on an already-active
`(trigger,target run,subject,eventKinds)` binding and add the owner
idempotently; they must not create duplicate deliveries to the same run.

The canonical plugin event gains transport metadata without changing its
existing payload:

```ts
export type CanonicalRouterEvent = {
  subjectKey: string;
  kind: string;
  payload: JsonObject;
  eventId?: string;
  subjectKind?: string;
  subjectRevision?: string;
  occurredAt?: string;
};
```

Those fields are absent from today's three-field shape
(`src/types.ts:179-183`). Provider normalizers set them when the provider
supplies them; the dispatch boundary durably fills `eventId` and `occurredAt`
when absent. A head-bearing event updates `binding.lastSubjectRevision`. A
non-head-bearing activity event may inherit that persisted binding revision,
but may not invent an empty revision. A run binding with neither event nor
persisted revision refuses delivery and alarms until a revision-bearing
webhook or poll refresh arrives.

### 1.5 Persistent run-delivery retry queue

The current `DeliveryState` persists trigger throttles, batches, and jobs
(`src/types.ts:222-231`), and `DeliveryManager` restores those queues
(`src/delivery.ts:16-75`). It removes a job from that queue before handing it
to the action executor (`src/delivery.ts:180-230`), so it is not an at-least-
once external-delivery outbox. Comb transport gets a separate durable store:

```text
~/.pollinate/state/run-delivery/
  records/<sha256-of-delivery-id>.json
  lanes/<sha256-of-lane-key>.json
  lanes/<sha256-of-lane-key>.lock
  index.json
```

```ts
export type RunDeliveryStatus =
  | "pending"
  | "delivering"
  | "retry-wait"
  | "failed";

export type RunDeliveryRecord = {
  schemaVersion: 1;
  id: string; // stable globally unique delivery ID/event ID
  requestDigest: string; // canonical operation digest; detects ID reuse
  triggerId: string;
  jobId?: string;
  laneKey: string;
  operation: CombTransportOperation;
  status: RunDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  queuedAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  lastExitCode?: number | null;
  lastError?: string;
};

export type RunDeliveryLane = {
  schemaVersion: 1;
  key: string; // `${sourceId}\0${subjectKind}\0${subjectKey}`
  sourceId: string;
  subjectKind: string;
  subjectKey: string;
  nextSubjectSequence: number;
  deliveryIds: string[]; // FIFO; only the head may execute
  paused?: { at: string; reason: string };
  updatedAt: string;
};
```

Records are written atomically before their first external attempt. Lane
mutation uses the existing file-lock/atomic-write primitives
(`src/fsx.ts:50-69`, `src/fsx.ts:126-180`). Enqueue under the lane lock:

1. Resolve or allocate the next safe integer subject sequence.
2. Freeze the complete event/observation and request digest.
3. Write the delivery record.
4. Append its ID and advance `nextSubjectSequence` in the lane.
5. Only then may a poll cursor, webhook response, or upstream acknowledgement
   advance.

Startup repair scans records before accepting a new enqueue. A record written
before a crash but missing from its lane is re-indexed; the lane's next
sequence becomes `max(persisted next, max record sequence + 1)`. The same
delivery ID plus same digest is an idempotent enqueue; the same ID plus a
different digest pauses the lane and ledgers a contract violation.

Only a lane head is attempted. A transport failure, timeout, missing process,
or canonical exit 7 sets `retry-wait`; all other nonzero exits are permanent
failures surfaced on the job and ledger. Backoff is exponential and bounded;
the sweep only selects due records. Acknowledged intake and successful run
instantiation remove the record and lane entry. Removing the head immediately
makes the next source-ordered item eligible.

The recovered seal fixes the sweep cadence to `bindingGcMs`. That cadence is
already configurable and defaults to 60 seconds (`src/config.ts:32-41`,
`src/config.ts:67-74`); the daemon already owns a non-overlapping interval on
that cadence (`src/daemon.ts:58-77`, `src/daemon.ts:124-153`). The outbox sweep
is added to that interval before router GC so terminal acknowledgements can
close bindings in the same pass.

The outbox retains undelivered records until acknowledgement or an explicit
operator resolution. Capacity is at least 100,000 records and seven days as
required by the engine §5.4. Capacity exhaustion pauses the affected trigger
and lane and emits an alarm; it never discards the oldest terminal event.

### 1.6 Observation spec

An observation trigger is a third trigger sink alongside `action` and
`router`. Phase 1 requires exactly one of the three so dispatch is
unambiguous:

```ts
export type ObservationSpec = {
  observationType: string; // literal, e.g. "ci-status"
  subjectKind: string; // literal, e.g. "pull-request"
  subjectKey: string; // JSONPath into normalized payload
  subjectRevision: string; // required JSONPath, e.g. "$.head_sha"
  value: string; // JSONPath
  eventId?: string; // JSONPath; generated durably when absent
  observedAt?: string; // JSONPath; activation.receivedAt fallback
  causation?: {
    effectKey?: string; // JSONPath
    operationId?: string; // JSONPath
  };
  metadata?: Record<string, string>; // output key -> JSONPath
};

export type Trigger = ExistingTrigger & {
  observation?: ObservationSpec;
};
```

Every path is evaluated with the existing `jsonpath-plus` wrapper
(`src/jsonpath.ts:1-10`), the same primitive used by webhook transforms
(`src/webhook.ts:270-278`). Missing `subjectKey`, `subjectRevision`, or `value`
is a hard normalization/delivery error. No empty-string or arrival-time
revision fallback exists.

`sourceId` is the stable trigger ID. `subjectSequence` is allocated from the
subject lane. A provider event ID is preferred; otherwise Pollinate allocates
one when the outbox record is created and preserves it on every retry.
`observedAt` describes provider observation time when available and otherwise
uses the activation receipt time. It never determines ordering.

Observation shaping happens after source normalization/filtering and before
external delivery at the `DeliveryManager.handle` choke point
(`src/delivery.ts:37-50`). It produces exactly one canonical observation per
activation. Batching may not merge observation values; observation triggers
must use immediate delivery in phase 1. Poll-backed terminal/strict sources
re-emit current state with a new event ID and higher subject sequence, even
when the value is unchanged.

### 1.7 GitHub revision fields

The built-in plugin already normalizes PR, comment, review, check-run, and
check-suite events (`src/router-plugins/github-pr.ts:29-63`) through shared PR
payload builders (`src/router-plugins/github-pr.ts:148-181`). It changes
additively:

- PR-bearing events add `pr_head_sha` from `pull_request.head.sha` and the
  common alias `head_sha` with the same value.
- `check_run` adds `head_sha` from `check_run.head_sha`.
- `check_suite` adds `head_sha` from `check_suite.head_sha`.
- When a check payload includes `pull_requests[0].head.sha`, it also adds
  `pr_head_sha`; absence does not synthesize a value.
- GitHub's `x-github-delivery` is normalized into a stable `eventId`
  (qualified by canonical event kind and subject if one webhook yields more
  than one event); retries preserve it.
- Existing payload keys and event kinds remain unchanged.

An observation configured with `subjectRevision = "$.head_sha"` fires only
when that field exists. Comment payloads that do not carry a provider head SHA
remain valid router activity but cannot become revision-sensitive evidence.
Pollinate must not call GitHub to fill the omission: external fetch remains a
configured source, not hidden normalizer behavior.

### 1.8 Owner-scoped observation coverage

Coverage controls whether a standing observation trigger emits for a subject.
It does not create or mutate triggers:

```ts
export type ObservationCoverage = {
  schemaVersion: 1;
  id: string; // deterministic digest of trigger/subject/eventKinds
  triggerId: string;
  subjectKind: string;
  subjectKey: string;
  eventKinds: string[]; // sorted unique
  owners: Record<
    string,
    {
      idempotencyKey: string;
      requestedAt: string;
      updatedAt: string;
    }
  >;
  createdAt: string;
  updatedAt: string;
};
```

`refCount` is `Object.keys(owners).length`. A repeated request by the same
owner and idempotency key returns the same request ID. A conflicting
idempotency key/request digest is exit 4. Release removes only the named
owner; the coverage gate closes only at refcount zero. This fixes S7: two runs
requesting the same trigger/subject cannot overwrite one another.

Coverage records live under `state/observation-coverage/`, use exact IDs for
release, and share the existing atomic-file/lock discipline. They have no TTL
in the normal protocol: Honeybee owns ordered teardown. GC may diagnose or
repair orphaned owners, but it cannot silently remove a live owner's reference
on a three-strikes heuristic.

## 2. Module layout

### 2.1 New modules

| File | Responsibility |
|---|---|
| `src/comb-transport.ts` | Canonical `hive comb run/event/observe` argv, stdin, envelope validation, exit classification. |
| `src/run-delivery.ts` | Durable records, per-subject lanes, sequence allocation, retry/backoff, acknowledgement, startup repair. |
| `src/observations.ts` | `ObservationSpec` validation, JSONPath extraction, canonical payload construction, coverage matching. |
| `src/coverage.ts` | Owner-scoped/ref-counted request/release store and command handlers. |
| `src/bindings.ts` | Programmatic register/unregister operations and idempotency; router event delivery remains in `router.ts`. |

### 2.2 Changed modules

| File | Change and current grounding |
|---|---|
| `src/types.ts` | Add `CombRunAction`, target union, observation/coverage/delivery records, and typed job result. The present action and target definitions are at `src/types.ts:58-90` and `src/types.ts:185-211`. |
| `src/config.ts` | Normalize literal name/version/product/input and `[trigger.observation]`; accept exactly one sink. Current action normalization is centralized at `src/config.ts:328-419`. |
| `src/templates.ts` | Add strict typed whole-placeholder rendering for Comb input without rendering `comb`/`product`/`version`. Existing behavior is at `src/templates.ts:11-27` and `src/templates.ts:67-100`. |
| `src/actions.ts` | In the action slice, invoke Comb run transport directly, validate the run envelope, store `runId`, and leave `parseHiveHandle` only on spawn. Durable enqueue and `targetKind:"run"` remain the transport/bindings slices. |
| `src/process.ts` | No semantic change; continue argv execution and stdin piping at `src/process.ts:29-40` and `src/process.ts:43-73`. |
| `src/store.ts`, `src/fsx.ts` | Add delivery, lane, coverage, and multi-binding paths plus atomic/locked CRUD. Current store paths and binding lock are `src/store.ts:60-94` and `src/store.ts:235-247`. |
| `src/delivery.ts` | Shape observations and durably enqueue before execution. Existing queue persistence is `src/delivery.ts:180-305`. |
| `src/poll.ts` | Persist all outbox records before cursor advancement. Current code advances the cursor before dispatch at `src/poll.ts:53-75`; that crash boundary must reverse. |
| `src/webhook.ts` | Preserve provider delivery ID, persist a Comb delivery before returning 202, and stop relying on the in-memory dedupe cache for durability. Current response-before-async-dispatch is `src/webhook.ts:144-181`. |
| `src/router.ts` | Route by target kind, produce canonical events, parse intake acks, deliver close events to runs, and close on terminal ack. Current subject lock is `src/router.ts:50-95`. |
| `src/router-plugins/github-pr.ts` | Add head revision and stable event fields without changing current payloads (`src/router-plugins/github-pr.ts:65-181`). |
| `src/router-gc.ts` | Make terminal acknowledgement authoritative; retain idle/reconciliation repair. Current GC policies are `src/router-gc.ts:38-40` and `src/router-gc.ts:53-73`. |
| `src/daemon.ts` | Sweep due run deliveries on `bindingGcMs` before binding GC. Current interval and non-reentrancy are `src/daemon.ts:58-77` and `src/daemon.ts:124-153`. |
| `src/cli.ts` | Add programmatic binding registration and observation request/release commands. Current bindings surface is list/get only (`src/cli.ts:488-499`). |

## 3. Surfaces

### 3.1 Comb action TOML, argv, errors, and run back-reference

Example trigger:

```toml
[trigger]
id = "pollinate-pr-track"
name = "Pollinate PR track"
cwd = "/Users/trmd/Projects/trmd/pollinate/repos/pollinate"
enabled = true

[trigger.source]
kind = "webhook"

[trigger.source.webhook]
path = "github/pollinate/pr-track"
secret = "env:GITHUB_WEBHOOK_SECRET"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 1

[trigger.action]
kind = "honeybee"
run = "comb"
comb = "human-last-pr"
version = 3
product = "pollinate"
collision = "join-existing"

[trigger.action.input]
repo = "{{repo}}"
prNumber = "{{pr_number}}"
headSha = "{{head_sha}}"
openedEvent = "{{event}}"
```

`comb`, `product`, and `version` are inspected statically before rendering.
The input is rendered to one JSON object and written to stdin.

**ALIGN-TO-ENGINE-REV (C5-1):** The invocation is the exact engine §5.4
provenance form:

```text
hive comb run <comb> --version <n> --input - --cwd <cwd> --product <key>
  --origin-trigger <trigger-id> --origin-delivery <delivery-id>
  [--collision refuse|join-existing] --json
```

Optional `--collision refuse|join-existing` is appended only when the action
declares it. `deliveryId` is globally unique and durable; a provider delivery
ID is qualified by trigger/source, while sources without one use the persisted
job UUID. The same ID always replays the same request digest. Strict-spine
slice 1 rejects `--event-json`; the event enters the run only through the
typed `input` mapping in this slice.

**LATER TRANSPORT SLICE — ALIGN-TO-ENGINE-REV (C2-1):** Once subscriptions
and run-event transport are enabled, the origin event is exactly:

```ts
export type RoutedRunEvent = {
  eventId: string;
  triggerId: string;
  deliveryId: string;
  eventKind: string;
  subject: {
    kind: string;
    key: string;
    revision: string;
  };
  occurredAt: string;
  order: {
    sourceId: string;
    subjectSequence: number;
  };
  payload: JsonValue;
};
```

**ALIGN-TO-ENGINE-REV (C10-1):** Exit 0 must contain exactly one newline-
terminated JSON envelope with `ok:true`, `command:"comb.run"`, and a validated
result. Human diagnostics belong to stderr. No stdout token is parsed:

```ts
{
  ok: true,
  command: "comb.run",
  result: {
    run: RunBoardView,
    created: boolean,
    joinedExisting: boolean,
    replayedDelivery: boolean,
    intakeReady: boolean
  }
}
```

The adapter reads `result.run.id`. `parseHiveHandle` stays unchanged for
`run:"spawn"` only; its permissive token scan (`src/actions.ts:394-407`) is
never called for a Comb.

**ALIGN-TO-ENGINE-REV (C10-2):** Exit codes are classified exactly as engine
§5.2: 0 valid success/ack; 2 invalid input/schema; 3 not found; 4
version/claim/idempotency conflict; 5 ambiguous activation/approval required;
6 unresolved effect ambiguity; 7 external dependency/transient transport;
70 internal/corrupt state. Only process transport failures and exit 7 retry.
An exit-0 malformed envelope is a non-retryable integration alarm, not a
successful run.

Failure stdout has the same single-envelope discipline:

```ts
{
  ok: false,
  command: "comb.run",
  error: {
    code:
      | "invalid_argument"
      | "not_found"
      | "version_conflict"
      | "claim_conflict"
      | "ambiguous_activation"
      | "cancelled"
      | "approval_required"
      | "effect_ambiguous"
      | "external_dependency"
      | "corrupt_state";
    message: string;
    details?: JsonValue;
  };
}
```

A claim refusal's `details` is exactly
`{claimId,holdingRunId,holdingRunStatus,cleanupStatus}`. Pollinate never
scrapes the pretty stderr line for its holder.

The completed Pollinate job stores:

```ts
{
  deliveryId: string;
  runId: string;
  comb: string;
  version: number;
  created: boolean;
  joinedExisting: boolean;
  replayedDelivery: boolean;
  intakeReady: boolean;
}
```

**ALIGN-TO-ENGINE-REV (C5-2):** Only a fresh
`created && !replayedDelivery` result appends
`pollinate.comb.run_started {trigger_id,delivery_id,event_id,comb,version,run_id}`.
A joined or replayed result emits no second event and creates no second
Flightboard association.

Until the later canonical-event slice lands, `event_id` equals the stable
delivery ID. That avoids inventing a revision-bearing routed event while the
strict-spine engine rejects `--event-json`.

**ALIGN-TO-ENGINE-REV (C5-3):** `join-existing` succeeds only after Honeybee
atomically accepts the optional origin event into exactly one subscription
matching `(triggerId,eventKind,subject.kind,subject.key)`. Pollinate trusts
`joinedExisting`; it neither reimplements that match nor opens a speculative
second binding. A refusal is exit 4 with structured claim-holder details and
is terminal for this delivery.

### 3.2 Subject → run handshake and delivery

There are two entry patterns:

1. **Router-opened run.** A configured router `onOpen` is a Comb action.
   Successful execution returns `targetKind:"run"` and the binding persists
   `{kind:"run",runId}`. Honeybee may subsequently register the matching
   subscription owner; registration adopts/refers to the existing binding
   rather than creating a duplicate target delivery.
2. **Engine-registered run.** A manual, attached, or child run asks Pollinate
   to register each node subscription. The binding becomes active only after
   the idempotent command result is persisted by Honeybee.

The four engine-facing `pol` mutations below emit exactly one
`{ok,command,result|error}` envelope and use exits 0/2/3/4/7. This is stricter
than the current generic `--json` printer and top-level `{error}` stderr
handler (`src/cli.ts:1948-1950`, `src/cli.ts:2077-2086`); these subcommands
must not inherit that legacy shape.

**ALIGN-TO-ENGINE-REV (C4-1):** Registration uses the exact engine §5.4
adapter command:

```text
pol bindings register --trigger <trigger-id> --target-kind comb-run
  --target-id <run-id> --subject-kind <kind> --subject <key>
  --event-kinds <comma-list> --owner <run-id>:<subscription-id>
  --idempotency-key <effect-key> --json
```

```json
{
  "ok": true,
  "command": "pol.bindings.register",
  "result": {
    "bindingId": "string",
    "created": true,
    "owner": "<run-id>:<subscription-id>"
  }
}
```

**ALIGN-TO-ENGINE-REV (C4-2):** Exact unregister:

```text
pol bindings unregister --binding-id <binding-id>
  --owner <run-id>:<subscription-id>
  --idempotency-key <effect-key> --json
```

```json
{
  "ok": true,
  "command": "pol.bindings.unregister",
  "result": {
    "bindingId": "string",
    "removed": true,
    "owner": "<run-id>:<subscription-id>"
  }
}
```

Every matching canonical router event becomes one frozen `RoutedRunEvent`.
Its subject revision is the event's explicit head revision or the binding's
persisted last head revision. If neither exists, enqueue fails closed. The
per-subject lock that already serializes router transitions
(`src/router.ts:50-95`) now serializes enqueue/close decisions, but the lock is
released before external execution. The durable lane preserves order across
retries.

**ALIGN-TO-ENGINE-REV (C2-2):** Run-targeted delivery is:

```text
hive comb event <run-id> --event - --json
```

The exact `RoutedRunEvent` is stdin. The success result is:

```json
{
  "ok": true,
  "command": "comb.event",
  "result": {
    "runId": "string",
    "subscriptionIds": ["string"],
    "ack": {
      "accepted": true,
      "reason": "accepted",
      "eventId": "string"
    }
  }
}
```

**ALIGN-TO-ENGINE-REV (C16-1):** Pollinate assigns
`order.sourceId = trigger.id` and a monotonically increasing safe integer
`subjectSequence` per `(sourceId,subject.kind,subject.key)`. The event ID and
sequence are frozen before the first attempt and remain unchanged on retry.
Arrival timestamps do not order events.

**ALIGN-TO-ENGINE-REV (C16-2):** Pollinate's lane is transport ordering only.
Honeybee owns subscription-local `"queue"` versus `"coalesce-latest"`,
watermarks, revision supersession, old-activation cleanup, and inert late
evidence. Pollinate does not independently coalesce after the outbox write.

**ALIGN-TO-ENGINE-REV (C16-3):** A lower sequence, duplicate event, or mixed
fan-out retry is interpreted solely from Honeybee's acknowledgement. Pollinate
never advances/relabels a retry to make it look fresh and never reuses one
sequence for a different event ID.

Close events are delivered to run targets before closing the binding. They are
not translated to the Hive `kill` default currently returned by
`defaultCloseAction` (`src/router.ts:254-256`). If trigger configuration calls
for run cancellation, the configured close path uses `hive comb cancel` only
after the close event is durably classified. Honeybee's explicit unregister
remains the normal teardown.

**ALIGN-TO-ENGINE-REV (S10-1):** Schema-valid intake always exits 0, including
`accepted:false`. The reasons are exactly `duplicate`, `stale`, `terminal`,
`no-matching-subscription`, `no-active-consumer`, or `ordering-conflict` in
addition to `accepted`.

**ALIGN-TO-ENGINE-REV (S10-2):** `accepted:false,reason:"terminal"` is the
leak-guard signal: Pollinate acknowledges/removes the outbox record and closes
or drops that run binding. It does not increment `activity_errored`, retry, or
wait for the existing three-open-attempt GC. Binding lifecycle is field-driven,
not exit-code-driven.

Other non-accepted reasons also acknowledge the outbox record:

- `duplicate` and `stale`: no state change and no retry;
- `no-matching-subscription`/`no-active-consumer`: ledger diagnostic, no
  retry; normal registration/GC repair decides binding fate;
- `ordering-conflict`: ledger a transport violation, pause the lane, no blind
  replay.

### 3.3 Observation channel

Example standing GitHub check observation:

```toml
[trigger]
id = "github-pollinate-checks"
name = "GitHub checks for pollinate"
cwd = "/Users/trmd/Projects/trmd/pollinate/repos/pollinate"
enabled = true

[trigger.source]
kind = "webhook"

[trigger.source.webhook]
path = "github/pollinate/checks"
secret = "env:GITHUB_WEBHOOK_SECRET"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 1

[trigger.observation]
observationType = "ci-status"
subjectKind = "pull-request"
subjectKey = "$.subject_key"
subjectRevision = "$.head_sha"
eventId = "$.event_id"
observedAt = "$.observed_at"
value = "$.check_conclusion"

[trigger.observation.metadata]
check = "$.check_name"
status = "$.check_status"
```

The built-in router plugin may feed the normalized payload into this spec; a
plain webhook transform may do the same. Coverage is checked after extracting
the subject and before sequence allocation. No owner means no outbox record.
One or more owners means one subject-addressed observation delivery; Honeybee
fans it out.

**ALIGN-TO-ENGINE-REV (C2-3):** Observation delivery is the exact engine §5.1
subject-addressed command:

```text
hive comb observe --subject-kind <kind> --subject <key>
  --subject-rev <revision> --event-id <id> --type <observation-type>
  --observed-at <iso8601> --source-id <id> --subject-sequence <n>
  --value - [--causation <file>] [--metadata <file>] --json
```

Only `value` uses stdin. When present, causation and metadata are written as
JSON to private temporary files, passed by path, and removed after the child
exits. There is no run or node argument.

**ALIGN-TO-ENGINE-REV (C2-4):** The engine fans the observation out to every
matching active subscription and every resolvable current action verifier.
Pollinate validates the top-level and per-delivery `IntakeAck`s, but does not
choose consumers.

**ALIGN-TO-ENGINE-REV (C10-3):** The success result and all failure/exit
fixtures for observe come verbatim from the shared versioned `contracts/`
golden corpus. Pollinate tests may not restate a local approximation:

```ts
{
  observationId: string;
  deliveries: Array<{
    runId: string;
    subscriptionId?: string;
    verifierEffectKey?: string;
    accepted: boolean;
    reason: IntakeAck["reason"];
  }>;
  ack: IntakeAck;
}
```

Top-level observation `ack` is accepted when at least one consumer accepts.
It is duplicate/stale/ordering-conflict only when every matched consumer has
that classification; otherwise an empty match is `no-active-consumer`. If one
run cannot be locked/written, the whole command exits 7 and Pollinate retries
the same event ID for every consumer; already-accepted consumers dedupe it.

**ALIGN-TO-ENGINE-REV (C4-3):** Coverage request uses:

```text
pol observe request --trigger <trigger-id> --subject-kind <kind>
  --subject <key> --event-kinds <comma-list>
  --owner <run-id>:<subscription-id>
  --idempotency-key <effect-key> --json
```

```json
{
  "ok": true,
  "command": "pol.observe.request",
  "result": {
    "requestId": "string",
    "created": true,
    "owner": "<run-id>:<subscription-id>",
    "refCount": 1
  }
}
```

**ALIGN-TO-ENGINE-REV (C4-4):** Coverage release uses:

```text
pol observe release --request-id <request-id> [--binding-id <binding-id>]
  --owner <run-id>:<subscription-id>
  --idempotency-key <effect-key> --json
```

```json
{
  "ok": true,
  "command": "pol.observe.release",
  "result": {
    "requestId": "string",
    "released": true,
    "owner": "<run-id>:<subscription-id>",
    "refCount": 0
  }
}
```

Registration ordering is binding register → persist binding ID → coverage
request → persist request ID. Action observation watches perform coverage only.
Teardown is unregister exact binding → release exact owner-scoped coverage.

## 4. Claims interplay: what Pollinate does not do

Pollinate provides delivery hygiene, not graph or claim semantics:

- It does not acquire, release, inspect, or race-resolve Honeybee subject
  claims.
- It does not deduplicate by Comb name, PR number, or Flightboard row.
  `originDelivery` only makes one instantiation request idempotent.
- It does not decide whether a claim collision may join. It forwards
  `collision` and consumes Honeybee's structured result.
- It does not select a subscription on `join-existing`; Honeybee atomically
  matches and accepts the event or refuses.
- It does not implement queue/coalesce activation policy, revision
  supersession, cancellation fencing, evidence matching, or strict action
  verification.
- It does not mark a run done because a provider state looks terminal.
  Provider state is an observation; Honeybee evaluates it.
- It does not fetch GitHub, CI, or deployment state on Honeybee's behalf.
  Poll-backed sources are explicit Pollinate triggers with explicit
  credentials and normalization.
- It does not send provider credentials in events or observations.
- It does not release coverage because a binding merely errored. Exact
  owner-scoped teardown or explicit repair owns release.
- It does not compensate an external mutation or infer that Honeybee will.

The existing binding lock remains useful for one-subject transport
serialization (`src/router.ts:50-95`), but it is not a distributed claim lock
and cannot substitute for Honeybee's subject claim.

## 5. Migration

### 5.1 Existing triggers and flow actions

`run:"flow"` and every existing Honeybee mode remain unchanged in the union
and executor (`src/types.ts:58-77`, `src/actions.ts:253-313`). No flow trigger
is automatically converted. Re-authoring is:

1. Define and validate an immutable Comb version in Honeybee.
2. Save the Pollinate trigger with literal `comb`/`product` and required
   `version`.
3. If trigger save fails, retry only the trigger save; the unreferenced Comb
   version changes no existing automation.
4. Remove the old flow trigger only after the pinned Comb trigger is enabled
   and observed.

Hand-authored floating or templated Comb triggers fail normalization. A
read-only migration lint may identify them, but runtime never silently pins
latest.

### 5.2 Stored bindings

On read, a target with current `{kind:"hive",handle}` shape is unchanged.
Records predating `kind` may be normalized to Hive only if the legacy `handle`
field exists. Run targets always require explicit `{kind:"run",runId}`; a
bare string is never guessed to be a run.

The store migrates from one subject-named file to binding-ID files under the
same trigger directory while holding the existing subject lock. The old file
is retained until the new file validates, then moved to a migration archive.
No bulk rewrite happens at daemon start.

### 5.3 Delivery and cursor cutover

No Comb event/observation trigger is enabled until:

- startup repair and per-subject outbox lanes are live;
- poll cursor advancement occurs after outbox persistence;
- webhook 202 occurs after outbox persistence;
- terminal acknowledgement closes run bindings;
- the chosen normalizer emits a nonempty subject revision; and
- terminal/strict webhook state has a poll-backed fallback.

Existing non-Comb jobs continue through `DeliveryState`. Comb transport alone
uses the run-delivery outbox.

### 5.4 Observation coverage

Observation triggers are static, initially disabled, and enabled only after
their provider fixtures pass. Coverage requests gate subjects inside those
triggers. Migration never creates one trigger per run or per PR.

## 6. Staged build plan

Each slice is independently checkable. Later slices stay disabled until their
golden contracts exist.

1. **Pinned Comb action.** Add types/config/TOML, literal validation, typed
   input rendering, argv/stdin execution, exact envelope parsing, job
   back-reference, and `run_started`. Consume the shared run fixtures.
2. **Durable transport.** Add records, lanes, sequence allocation, startup
   repair, retry classification, bounded backoff, daemon sweep, cursor/webhook
   ordering, capacity pause/alarm, and operational inspection.
3. **Run bindings.** Add the target union, multi-owner binding storage,
   register/unregister commands, router-created registration adoption,
   run-event delivery, close-event ordering, terminal acknowledgement, and
   exact teardown.
4. **Observations and coverage.** Add `ObservationSpec`, owner-scoped coverage
   request/release, subject-addressed delivery, GitHub head revisions,
   causation, check-run/check-suite fixtures, and poll fallback.
5. **Cross-system cutover.** Run the shared corpus in Pollinate/Honeybee,
   fault-inject every persistence boundary, wire Apiary's trigger-pair/job
   back-reference, rehearse a disposable PR track, update CLI help/docs, then
   enable Comb triggers.

Every slice runs `pnpm check`. Complex Apiary Flightboard behavior is manually
verified after its adapter lands.

## 7. Test plan

### 7.1 Unit tests

- **Config/action:** literal name, templated-name refusal, positive version,
  collision enum, JSON/TOML round trip, exactly-one-sink validation.
- **Typed mapping:** numeric/boolean/null/object/array whole placeholders;
  invalid-JSON string fallback; mixed literal string; nested arrays/objects;
  fatal unresolved variables; `comb` never rendered.
- **Envelope parsing:** command mismatch, missing/invalid run ID, every exit
  code, malformed stdout, stdout purity, stderr diagnostics. Prove
  `parseHiveHandle` remains exercised only by spawn.
- **Lane machine:** FIFO, stable IDs/sequences, duplicate enqueue digest,
  conflicting digest, lower/higher lanes, retry eligibility, bounded backoff,
  pause/capacity, head removal, no-op sweep.
- **Observation:** every JSONPath field, missing revision refusal, metadata and
  causation, generated event ID, receipt-time fallback, typed value
  preservation.
- **Coverage:** same-owner replay, same selector with two owners, release one
  owner without stopping the other, last-owner release, conflicting
  idempotency key.
- **GitHub:** PR/check-run/check-suite head fields; legacy payload equality
  except additive keys; comments without a head do not emit revision-sensitive
  observations.

Current template tests already cover unresolved placeholders and recursive
action rendering (`tests/templates.test.ts:5-28`,
`tests/templates.test.ts:58-88`). Current config tests cover router/action
normalization and unsupported modes (`tests/config.test.ts:49-128`,
`tests/config.test.ts:144-180`). Extend those suites rather than duplicate
parsers.

### 7.2 Store and crash-boundary integration tests

Using the existing temporary-store helper (`tests/helpers.ts:8-21`) and a fake
clock:

- crash before record write, after record write/before lane index, after lane
  write/before cursor, after cursor/before attempt, after execute/before ack
  deletion, and after deletion/before job update;
- startup re-indexing and sequence repair;
- simultaneous enqueue under the real file lock;
- engine down across multiple daemon sweeps;
- daemon restart with due and not-due records;
- 100,000-record capacity behavior without dropping the head;
- poll repeats after crash dedupe to the same outbox request;
- webhook redelivery after daemon restart dedupe by durable ID rather than the
  in-memory cache.

The current poll code and test fixtures already expose cursor behavior
(`src/poll.ts:53-75`, `tests/poll-webhook.test.ts:22-51`). The new tests must
prove cursor persistence happens after outbox persistence.

### 7.3 Router and observation integration tests

- router onOpen creates a run target from `targetKind:"run"`;
- engine registration adopts the same run binding rather than duplicating it;
- two independent owners sharing a subject both receive exactly one matching
  delivery per run;
- run activity enters the outbox while the subject lock is held, then executes
  after release;
- accepted/duplicate/stale/no-match/order-conflict/terminal acknowledgements;
- close event delivered before optional cancel;
- terminal ack closes immediately and does not produce
  `pollinate.router.activity_errored`;
- unregister then coverage release by exact persisted IDs;
- observation fan-out mixed accepted/duplicate result;
- strict success observation carries matching `effectKey`/`operationId`;
- webhook loss repaired by poll with a new sequence.

Current router integration tests cover built-in normalization, bindings,
sequences, errors, and ledger events (`tests/router.test.ts:7-224`,
`tests/router.test.ts:224-722`). GC tests already inject clocks and subject
state (`tests/router-gc.test.ts:43-220`).

### 7.4 CLI and shared contract tests

The command stub helper currently logs argv and returns spawn-style text
(`tests/helpers.ts:75-145`). Extend it to capture stdin separately and return
fixture-selected JSON envelopes.

Pollinate consumes, verbatim, the versioned shared `contracts/` cases for:

- Comb run create, delivery replay, join-existing, and claim refusal;
- run event accepted, duplicate, stale, terminal, no match, and ordering
  conflict;
- observation single/mixed fan-out and no active consumer;
- binding register/unregister and coverage request/release replay;
- every success/failure envelope and exit code.

Cross-repo fault injection covers: engine-down redelivery, cursor/outbox crash,
manual-claim join, racing push supersession, cancellation during delivery,
partial binding/coverage registration, and strict-action confirmation after a
lost webhook.

### 7.5 Repository gates and manual verification

Run `pnpm check` for every slice. Manually verify:

1. Apiary shows the static trigger × literal Comb pair before a run exists.
2. A firing links from its Pollinate job to the Honeybee run.
3. A joined claim creates no duplicate pair/run-start event.
4. A racing older push is acknowledged stale without cancelling newer work.
5. A cancelled/terminal run removes its binding after the field-level ack.
6. A missed check webhook is repaired by the poll-backed observation source.

## 8. Cross-system contract assumptions

These are rollout dependencies, not alternative wire contracts.

1. **Engine authority.** Honeybee's engine design owns all Comb argv,
   envelopes, exit codes, intake acknowledgements, ordering semantics, and
   teardown order. Pollinate changes when that contract changes.
2. **Versioned run input.** Trigger instantiation accepts one JSON value on
   stdin, requires a literal Comb name and version for trigger origin, accepts
   origin trigger/delivery plus one canonical event, and returns
   `result.run.id`.
3. **Idempotent intake.** Honeybee run-event and observation intake is
   idempotent on `eventId`; bounded in-memory seen-ID caches do not weaken
   durable idempotency because the engine checks its event/delivery index.
4. **Run delivery.** `originDelivery` is the instantiation idempotency key.
   Replay with the same request digest returns the same run result; conflicting
   reuse is a version conflict.
5. **Claims.** Honeybee's claim is authoritative across trigger, manual,
   attached, and child origins. Pollinate dedupe cannot authorize overlap.
6. **Registration.** Honeybee persists exact binding and coverage IDs before
   graph execution becomes intake-ready, and tears them down by those IDs in
   the canonical order.
7. **Ordering ownership.** Pollinate assigns stable IDs and monotonic
   per-subject source sequences. Honeybee applies watermarks,
   queue/coalesce-latest, revision supersession, and activation cleanup.
8. **Terminal acknowledgement.** Exit-0 `accepted:false,reason:"terminal"` is
   authoritative and safe to drop. A nonzero exit is never required to drive
   leak GC.
9. **Observation freshness.** Revision-sensitive consumers reject missing
   subject revisions. GitHub PR/check observations use provider head SHA, and
   strict/terminal state has a poll-backed source.
10. **Strict attribution.** Pollinate observations can carry effect-key or
    operation-ID causation. Pollinate does not decide whether that attribution
    completes or violates an engine action.
11. **Apiary join.** Apiary statically inspects literal
    `{comb,version}` trigger actions and uses Pollinate job `runId` plus
    Honeybee trigger associations for runtime back-joins. Templated Comb names
    are invalid.
12. **Shared enforcement.** Pollinate and Honeybee consume the same versioned
    `contracts/` golden corpus for signatures, stdin, envelopes, result
    fields, acknowledgement reasons, and exit codes; neither copies the
    fixtures into a local dialect.
13. **Single writers.** One Pollinate daemon owns a `POLLINATE_STORE_ROOT`.
    File locks serialize CLI races on that root. Separate computers exchange
    events through the documented transports; this design assumes neither a
    distributed filesystem lock nor shared local state.

## 9. Decisions challenged

The lost revision's seal says no working decisions remained challenged after
repair. This reconstruction preserves that conclusion:

- **C1:** JSON stdin and envelope run ID replace repeated `key=value` input
  and token scraping.
- **C3:** delivery is durable at-least-once, not drop-on-first-failure.
- **C13:** revision JSONPath and provider head SHA are mandatory before
  revision-sensitive enablement.
- **S7:** coverage is owner-scoped/ref-counted.
- **C17:** Comb references are literal and version-pinned.
- **C2/C4/C5/C10/C16/S10:** the engine's composed contracts win; Pollinate
  does not retain earlier local variants.

Any future proposal to template a Comb name, target an observation at a
run/node, treat terminal intake as an error, or coalesce a persisted lane in
Pollinate reopens a settled cross-system decision and requires coordinated
contract revision.

## 10. Open risks and unreconstructed details

1. **Exact Pollinate outbox retry timing was not preserved in the seal.** The
   recoverable contract is bounded exponential backoff swept on
   `bindingGcMs`; base, cap, and jitter from the stranded copy are unknown.
   The engine's separate 5,000/300,000 ms graph-retry constants do not resolve
   this Pollinate-owned choice. Before transport implementation, record the
   outbox constants in daemon config and shared fault-injection fixtures.
2. **The exact stranded internal filenames were not preserved.** The
   `state/run-delivery/` and `state/observation-coverage/` layout above is the
   reconstruction's scalable Pollinate-owned choice. Wire behavior and crash
   invariants are authoritative; a resurfaced copy may name these files
   differently.
3. **GitHub payload availability varies by event.** PR and check webhooks have
   head SHA sources; issue-comment payloads generally do not. Revision-
   sensitive observation triggers must filter to events that actually carry a
   revision or use an explicit poll source. Hidden API fetches are forbidden.
4. **Router-opened binding adoption needs a race proof.** The engine may issue
   registration immediately after `comb.run` while Pollinate is still
   confirming the router-created binding. The subject lock, target/owner
   convergence rule, and shared fixture must prove exactly one active delivery
   path.
5. **Outbox/job lifecycle requires operator UX.** A transient run delivery can
   outlive the action's first process attempt. CLI/job views need a visible
   retrying state and inspection/cancel/resume commands; presenting it as a
   completed or permanently errored ordinary job would be misleading.
6. **Cross-repo gating is real.** Event-only and strict-action Combs remain
   disabled until both sides pass the shared corpus and the poll fallback.
   Unit-green local adapters are insufficient.

If the stranded file resurfaces, diff it specifically for the two unrecovered
internal choices above (Pollinate outbox retry constants and store filenames)
and any additional GitHub event-ID rule. Canonical engine contracts still win
over either copy.
