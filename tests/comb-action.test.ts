import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ActionExecutor,
  buildCombRunInvocation,
  CombActionError,
  parseCombRunResult,
  parseTriggerToml,
  renderAction,
  renderCombInput,
  triggerToToml,
  type CombRunAction,
} from "../src/index.js";
import type { ExecResult } from "../src/process.js";
import { installHiveStub, trigger, withTempStore } from "./helpers.js";

const RUN_ID = "01JTESTCOMBRUN-1a2b";
const HOLDING_RUN_ID = "01JTESTHOLDING-3c4d";

// Materialized directly from Honeybee contracts/combs/v1/cli-golden.json
// cases comb-run-trigger-create, comb-run-trigger-replay,
// comb-run-join-refusal, and comb-transient-io-classification.
const GOLDEN = {
  created: {
    ok: true,
    command: "comb.run",
    result: {
      run: {
        id: RUN_ID,
        status: "active",
        origin: {
          kind: "trigger",
          triggerId: "trigger-corpus",
          deliveryId: "delivery-corpus",
        },
        intakeReady: false,
      },
      created: true,
      joinedExisting: false,
      replayedDelivery: false,
      intakeReady: false,
    },
  },
  replayed: {
    ok: true,
    command: "comb.run",
    result: {
      run: { id: RUN_ID },
      created: true,
      joinedExisting: false,
      replayedDelivery: true,
      intakeReady: false,
    },
  },
  claimRefusal: {
    ok: false,
    command: "comb.run",
    error: {
      code: "claim_conflict",
      message: `claim conflict: held by ${HOLDING_RUN_ID}`,
      details: {
        claimId: "a".repeat(64),
        holdingRunId: HOLDING_RUN_ID,
        holdingRunStatus: "active",
        cleanupStatus: "not-required",
      },
    },
  },
  transientIo: {
    ok: false,
    command: "comb.run",
    error: {
      code: "external_dependency",
      message: "fixture I/O interruption",
      details: {
        errno: "EIO",
      },
    },
  },
} as const;

const CORPUS_ACTION: CombRunAction = {
  kind: "honeybee",
  run: "comb",
  comb: "corpus-review",
  version: 1,
  product: "corpus-product",
  input: { ref: "other" },
};

describe("Comb action config and typed input mapping", () => {
  test("parses and round-trips an explicit product, pinned version, collision, and JSON input", () => {
    const parsed = parseTriggerToml(
      `[trigger]
id = "comb-trigger"
cwd = "/tmp/product"

[trigger.source]
kind = "manual"

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
openedEvent = "{{event}}"
`,
    );

    expect(parsed.action).toEqual({
      kind: "honeybee",
      run: "comb",
      comb: "human-last-pr",
      version: 3,
      product: "pollinate",
      collision: "join-existing",
      input: {
        repo: "{{repo}}",
        prNumber: "{{pr_number}}",
        openedEvent: "{{event}}",
      },
    });
    expect(parseTriggerToml(triggerToToml(parsed)).action).toEqual(parsed.action);
  });

  test("rejects inferred/templated identity, unpinned versions, invalid collision, and non-object input", () => {
    const toml = (action: string) => `[trigger]
id = "invalid-comb"

[trigger.source]
kind = "manual"

[trigger.action]
kind = "honeybee"
run = "comb"
${action}
`;

    expect(() => parseTriggerToml(toml('comb = "x"\nversion = 1\ninput = {}'))).toThrow(/product/);
    expect(() => parseTriggerToml(toml('comb = "{{comb}}"\nversion = 1\nproduct = "p"\ninput = {}'))).toThrow(/must be literal/);
    expect(() => parseTriggerToml(toml('comb = "x"\nversion = 1\nproduct = "{{product}}"\ninput = {}'))).toThrow(/must be literal/);
    expect(() => parseTriggerToml(toml('comb = "x"\nversion = 0\nproduct = "p"\ninput = {}'))).toThrow(/positive safe integer/);
    expect(() => parseTriggerToml(toml('comb = "x"\nproduct = "p"\ninput = {}'))).toThrow(/positive safe integer/);
    expect(() => parseTriggerToml(toml('comb = "x"\nversion = 1\nproduct = "p"\ncollision = "merge"\ninput = {}'))).toThrow(/collision/);
    expect(() => parseTriggerToml(toml('comb = "x"\nversion = 1\nproduct = "p"\ninput = []'))).toThrow(/Expected table/);
  });

  test("rejects Comb leaves inside routers while run bindings are out of scope", () => {
    expect(() =>
      parseTriggerToml(
        `[trigger]
id = "comb-router"

[trigger.source]
kind = "manual"

[trigger.router]
plugin = "github-pr"
openOn = ["github.pull_request.opened"]
closeOn = ["github.pull_request.closed"]

[trigger.router.onOpen]
kind = "honeybee"
run = "comb"
comb = "corpus-review"
version = 1
product = "corpus-product"
input = {}

[trigger.router.onActivity]
kind = "honeybee"
run = "send"
target = "{{binding.target}}"
message = "activity"
`,
      ),
    ).toThrow(/run bindings/);
  });

  test("coerces exact placeholders to JSON types, preserves mixed strings and keys, and fails unresolved input", () => {
    const rendered = renderCombInput(
      {
        number: "{{number}}",
        boolean: "{{boolean}}",
        nil: "{{nil}}",
        object: "{{object}}",
        array: "{{array}}",
        fallback: "{{fallback}}",
        mixed: "PR-{{number}}",
        nested: ["{{number}}", { "{{literal-key}}": "{{boolean}}" }],
      },
      {
        number: "421",
        boolean: "true",
        nil: "null",
        object: '{"repo":"trmd/pollinate"}',
        array: '[1,"two"]',
        fallback: "trmd/pollinate",
      },
    );

    expect(rendered).toEqual({
      number: 421,
      boolean: true,
      nil: null,
      object: { repo: "trmd/pollinate" },
      array: [1, "two"],
      fallback: "trmd/pollinate",
      mixed: "PR-421",
      nested: [421, { "{{literal-key}}": true }],
    });
    expect(() => renderCombInput({ missing: "{{missing}}" }, {})).toThrow("Unresolved Comb input template var: missing");
    expect(() => renderCombInput({ missing: "prefix-{{missing}}" }, {})).toThrow("Unresolved Comb input template var: missing");
  });

  test("renders only Comb input and never its immutable control fields", () => {
    const action: CombRunAction = {
      ...CORPUS_ACTION,
      comb: "{{comb}}",
      product: "{{product}}",
      input: { event: "{{event}}", label: "run-{{n}}" },
    };
    const rendered = renderAction(action, {
      comb: "wrong-comb",
      product: "wrong-product",
      event: '{"ok":true}',
      n: "7",
    });

    expect(rendered.value).toEqual({
      ...action,
      input: { event: { ok: true }, label: "run-7" },
    });
    expect(rendered.warnings).toEqual([]);
  });
});

describe("Comb transport golden seam", () => {
  test("builds the versioned argv/provenance contract and writes one JSON object to stdin", () => {
    const invocation = buildCombRunInvocation(
      { ...CORPUS_ACTION, collision: "join-existing" },
      "/tmp/comb-fixture",
      { triggerId: "trigger-corpus", deliveryId: "delivery-corpus" },
    );

    expect(invocation.args).toEqual([
      "comb",
      "run",
      "corpus-review",
      "--version",
      "1",
      "--input",
      "-",
      "--cwd",
      "/tmp/comb-fixture",
      "--product",
      "corpus-product",
      "--origin-trigger",
      "trigger-corpus",
      "--origin-delivery",
      "delivery-corpus",
      "--collision",
      "join-existing",
      "--json",
    ]);
    expect(invocation.args).not.toContain("--event-json");
    expect(invocation.input).toBe('{"ref":"other"}\n');
  });

  test("parses success and delivery replay from result.run.id without handle token scraping", () => {
    expect(parseCombRunResult(CORPUS_ACTION, "delivery-corpus", execResult(0, GOLDEN.created))).toEqual({
      deliveryId: "delivery-corpus",
      runId: RUN_ID,
      comb: "corpus-review",
      version: 1,
      created: true,
      joinedExisting: false,
      replayedDelivery: false,
      intakeReady: false,
    });
    expect(parseCombRunResult(CORPUS_ACTION, "delivery-corpus", execResult(0, GOLDEN.replayed))).toMatchObject({
      runId: RUN_ID,
      created: true,
      joinedExisting: false,
      replayedDelivery: true,
    });
  });

  test("accepts the composed join-existing success result without treating it as a new run", () => {
    const joined = {
      ok: true,
      command: "comb.run",
      result: {
        run: { id: HOLDING_RUN_ID },
        created: false,
        joinedExisting: true,
        replayedDelivery: false,
        intakeReady: true,
      },
    };
    expect(parseCombRunResult(CORPUS_ACTION, "delivery-join", execResult(0, joined))).toMatchObject({
      runId: HOLDING_RUN_ID,
      created: false,
      joinedExisting: true,
      replayedDelivery: false,
      intakeReady: true,
    });
  });

  test("surfaces canonical claim-holder details as a terminal refusal", () => {
    const failure = captureFailure(() =>
      parseCombRunResult(CORPUS_ACTION, "delivery-claim", execResult(4, GOLDEN.claimRefusal)),
    );
    expect(failure.result).toEqual({
      deliveryId: "delivery-claim",
      comb: "corpus-review",
      version: 1,
      retryable: false,
      exitCode: 4,
      error: GOLDEN.claimRefusal.error,
      holdingRunId: HOLDING_RUN_ID,
    });
  });

  test("classifies the corpus transient I/O envelope as retryable and all schema faults as terminal", () => {
    const transient = captureFailure(() =>
      parseCombRunResult(CORPUS_ACTION, "delivery-io", execResult(7, GOLDEN.transientIo)),
    );
    expect(transient.result).toMatchObject({
      retryable: true,
      exitCode: 7,
      error: GOLDEN.transientIo.error,
    });

    const malformed = captureFailure(() =>
      parseCombRunResult(CORPUS_ACTION, "delivery-bad", {
        ...execResult(0, GOLDEN.created),
        stdout: `${JSON.stringify(GOLDEN.created)}\nnoise\n`,
      }),
    );
    expect(malformed.result).toMatchObject({
      retryable: false,
      error: { code: "invalid_envelope" },
    });

    const signalled = captureFailure(() =>
      parseCombRunResult(CORPUS_ACTION, "delivery-signal", {
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        timedOut: false,
      }),
    );
    expect(signalled.result).toMatchObject({
      retryable: true,
      exitCode: null,
      error: { code: "transport_failure", message: "hive comb run terminated by SIGTERM" },
    });
  });
});

describe("Comb action job integration", () => {
  test("records the run back-reference, provider delivery replay, stdin, and one run_started event", async () => {
    await withTempStore(async (store, root) => {
      const inputPath = join(root, "comb-input.json");
      const replayMarker = join(root, "comb-replayed");
      const hiveLog = join(root, "hive.log");
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh
echo "$@" >> "${hiveLog}"
cat > "${inputPath}"
if [ -f "${replayMarker}" ]; then
  printf '%s\\n' '${JSON.stringify(GOLDEN.replayed)}'
else
  : > "${replayMarker}"
  printf '%s\\n' '${JSON.stringify(GOLDEN.created)}'
fi
`,
      });
      try {
        const combTrigger = trigger({
          id: "trigger-corpus",
          cwd: root,
          context: { static: { count: "421" } },
          action: {
            kind: "honeybee",
            run: "comb",
            comb: "corpus-review",
            version: 1,
            product: "corpus-product",
            input: {
              count: "{{count}}",
              openedEvent: "{{event}}",
            },
          },
        });
        const activation = {
          triggerId: combTrigger.id,
          source: "webhook" as const,
          payload: { repo: "trmd/pollinate" },
          receivedAt: new Date().toISOString(),
          metadata: { deliveryId: "guid-corpus-123" },
        };
        const stableDeliveryId = "pollinate:trigger-corpus:webhook:guid-corpus-123";
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1_000, commandTimeoutMs: 1_000 });
        const queued = await executor.createQueuedJob(combTrigger, activation, [activation.payload]);
        await store.saveJob(queued);

        const created = await executor.executeJob(queued, combTrigger, activation, [activation.payload]);
        expect(created.status).toBe("completed");
        expect(created.result).toEqual({
          deliveryId: stableDeliveryId,
          runId: RUN_ID,
          comb: "corpus-review",
          version: 1,
          created: true,
          joinedExisting: false,
          replayedDelivery: false,
          intakeReady: false,
        });
        expect(JSON.parse(await readFile(inputPath, "utf8"))).toEqual({
          count: 421,
          openedEvent: { repo: "trmd/pollinate" },
        });
        expect(await hive.log()).toContain(
          `comb run corpus-review --version 1 --input - --cwd ${root} --product corpus-product --origin-trigger trigger-corpus --origin-delivery ${stableDeliveryId} --json`,
        );

        const redelivered = await executor.createQueuedJob(combTrigger, activation, [activation.payload]);
        expect(redelivered.uuid).not.toBe(queued.uuid);
        await store.saveJob(redelivered);
        const replayed = await executor.executeJob(redelivered, combTrigger, activation, [activation.payload]);
        expect(replayed.status).toBe("completed");
        expect(replayed.result).toMatchObject({
          deliveryId: stableDeliveryId,
          runId: RUN_ID,
          replayedDelivery: true,
        });
        const ledger = (await store.readLedger()).map((line) => JSON.parse(line) as Record<string, unknown>);
        const started = ledger.filter((event) => event.event === "pollinate.comb.run_started");
        expect(started).toEqual([
          expect.objectContaining({
            trigger_id: "trigger-corpus",
            delivery_id: stableDeliveryId,
            event_id: stableDeliveryId,
            comb: "corpus-review",
            version: 1,
            run_id: RUN_ID,
          }),
        ]);
      } finally {
        hive.restore();
      }
    });
  });

  test("persists structured refusal and retryability on errored jobs", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh
printf '%s\\n' '${JSON.stringify(GOLDEN.claimRefusal)}'
exit 4
`,
      });
      try {
        const combTrigger = trigger({
          id: "trigger-claim",
          cwd: root,
          action: {
            ...CORPUS_ACTION,
            comb: "corpus-claim",
            collision: "join-existing",
          },
        });
        const activation = {
          triggerId: combTrigger.id,
          source: "manual" as const,
          payload: {},
          receivedAt: new Date().toISOString(),
        };
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1_000, commandTimeoutMs: 1_000 });
        const queued = await executor.createQueuedJob(combTrigger, activation, [activation.payload]);
        await store.saveJob(queued);

        const refused = await executor.executeJob(queued, combTrigger, activation, [activation.payload]);
        expect(refused.status).toBe("errored");
        expect(refused.result).toMatchObject({
          deliveryId: queued.uuid,
          retryable: false,
          exitCode: 4,
          error: { code: "claim_conflict" },
          holdingRunId: HOLDING_RUN_ID,
        });
        expect(refused.error).toContain(`held by ${HOLDING_RUN_ID}`);
      } finally {
        hive.restore();
      }
    });
  });

  test("fails unresolved Comb input before invoking Hive and marks the job errored", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const combTrigger = trigger({
          id: "missing-input",
          cwd: root,
          action: {
            ...CORPUS_ACTION,
            input: { missing: "{{missing}}" },
          },
        });
        const activation = {
          triggerId: combTrigger.id,
          source: "manual" as const,
          payload: {},
          receivedAt: new Date().toISOString(),
        };
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1_000, commandTimeoutMs: 1_000 });
        const queued = await executor.createQueuedJob(combTrigger, activation, [activation.payload]);
        await store.saveJob(queued);

        const failed = await executor.executeJob(queued, combTrigger, activation, [activation.payload]);
        expect(failed.status).toBe("errored");
        expect(failed.error).toContain("Unresolved Comb input template var: missing");
        expect(await hive.log()).toBe("");
      } finally {
        hive.restore();
      }
    });
  });
});

function execResult(exitCode: number, envelope: unknown): ExecResult {
  return {
    exitCode,
    signal: null,
    stdout: `${JSON.stringify(envelope)}\n`,
    stderr: "",
    timedOut: false,
  };
}

function captureFailure(run: () => unknown): CombActionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CombActionError);
    return error as CombActionError;
  }
  throw new Error("Expected CombActionError");
}
