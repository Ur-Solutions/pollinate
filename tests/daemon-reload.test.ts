import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PollinateDaemon, type PollinateStore, type RouterBinding, type Trigger } from "../src/index.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

async function waitForLedgerEvent(
  store: PollinateStore,
  event: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const matches = (await store.readLedger())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry: Record<string, unknown>) => entry.event === event);
    const match = matches[matches.length - 1];
    if (match) return match;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ledger event ${event}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function routerTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return trigger({
    id: "daemon-gc",
    source: { kind: "webhook", webhook: { path: "daemon/gc" } },
    action: undefined,
    router: {
      plugin: "github-pr",
      openOn: ["github.pull_request.opened"],
      closeOn: ["github.pull_request.merged"],
      idleTtl: "1ms",
      onOpen: { kind: "honeybee", run: "spawn", bee: "codex", name: "pr-{{pr_number}}" },
      onActivity: { kind: "honeybee", run: "send", target: "{{binding.target}}", message: "{{activity_markdown}}" },
      onClose: { kind: "emit", subject: "daemon-gc-close", payload: "{{subject_key}}" },
    },
    ...overrides,
  });
}

function binding(triggerId: string): RouterBinding {
  const stale = new Date(Date.now() - 60_000).toISOString();
  return {
    id: `${triggerId}.github:pull_request:trmd-demo#5`,
    triggerId,
    router: "github-pr",
    subjectKey: "github:pull_request:trmd/demo#5",
    status: "active",
    target: { kind: "hive", handle: "pr-5" },
    createdAt: stale,
    updatedAt: stale,
    lastActivityAt: stale,
    context: { pr_number: "5", repo: "trmd/demo" },
  };
}

describe("daemon trigger reload", () => {
  test("running daemon autoloads a trigger added after startup", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(root, "pollinate.toml"),
        `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 10
contextTimeout = "1s"
commandTimeout = "1s"
`,
      );

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        const trig = trigger({
          id: "autoloaded",
          source: { kind: "schedule", timing: { type: "once", at: new Date(Date.now() + 50).toISOString() } },
          action: { kind: "emit", subject: "autoloaded", payload: "{{event}}" },
        });
        await store.saveTrigger(trig);

        const [job] = await waitForTerminalJobs(store, 1, 1_500);
        expect(job.triggerId).toBe("autoloaded");
      } finally {
        await daemon.stop();
      }
    });
  });

  test("running daemon starts polling a poll trigger added after startup", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(root, "pollinate.toml"),
        `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 20
contextTimeout = "1s"
commandTimeout = "1s"
`,
      );
      const sourceFile = join(root, "events.jsonl");
      await writeFile(sourceFile, '{"id":1}\n');

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        const trig = trigger({
          id: "autoloaded-poll",
          source: {
            kind: "poll",
            poll: {
              interval: "1s",
              emit: "per-item",
              fetch: { kind: "file", path: sourceFile },
              cursor: { strategy: "append-offset" },
            },
          },
          action: { kind: "emit", subject: "autoloaded-poll", payload: "{{event}}" },
        });
        await store.saveTrigger(trig);

        const [job] = await waitForTerminalJobs(store, 1, 1_500);
        expect(job.triggerId).toBe("autoloaded-poll");
      } finally {
        await daemon.stop();
      }
    });
  });

  test("records reload errors and keeps already-loaded schedules running", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(root, "pollinate.toml"),
        `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 20
contextTimeout = "1s"
commandTimeout = "1s"
`,
      );
      await store.saveTrigger(
        trigger({
          id: "survives-reload-error",
          source: { kind: "schedule", timing: { type: "once", at: new Date(Date.now() + 60).toISOString() } },
          action: { kind: "emit", subject: "survives-reload-error", payload: "{{event}}" },
        }),
      );

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        await writeFile(join(root, "pollinate.toml"), "[defaults\n");

        const error = await waitForLedgerEvent(store, "pollinate.daemon.reload_errored");
        expect(error.error).toEqual(expect.any(String));

        const [job] = await waitForTerminalJobs(store, 1, 2_000);
        expect(job.triggerId).toBe("survives-reload-error");
      } finally {
        await daemon.stop();
        await daemon.stop();
      }
    });
  });

  test("runs binding GC on the configured daemon interval", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(root, "pollinate.toml"),
        `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 1000
bindingGcMs = 10
contextTimeout = "1s"
commandTimeout = "1s"
`,
      );
      const trig = routerTrigger();
      await store.saveTrigger(trig);
      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        await store.saveRouterBinding(binding(trig.id));

        const gc = await waitForLedgerEvent(store, "pollinate.router.gc", 2_000);
        expect(gc.expired).toEqual([`${trig.id}.github:pull_request:trmd-demo#5`]);

        const updated = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(updated?.status).toBe("closed");
        expect((await store.readLedger()).join("\n")).toContain("daemon-gc-close");
      } finally {
        await daemon.stop();
        await daemon.stop();
      }
    });
  });
});
