import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ledgerPath, PollinateDaemon, type Job, type PollinateStore } from "../src/index.js";
import { withTempStore } from "./helpers.js";

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

function oldTerminalJob(id: string): Job {
  const old = new Date(Date.now() - 60_000).toISOString();
  return {
    id,
    triggerId: "daemon-retention",
    source: "manual",
    status: "completed",
    context: {},
    queuedAt: old,
    completedAt: old,
  };
}

function freshRunningJob(id: string): Job {
  // Deliberately recent (not stale by STALE_JOB_RECOVERY_MS) so daemon startup's
  // own recoverStaleJobs leaves it alone — this test is about gc, not recovery.
  const now = new Date().toISOString();
  return {
    id,
    triggerId: "daemon-retention",
    source: "manual",
    status: "running",
    context: {},
    queuedAt: now,
    startedAt: now,
  };
}

describe("daemon job + ledger retention", () => {
  test("runs jobs gc on the configured retention interval and never touches non-terminal jobs", async () => {
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
contextTimeout = "1s"
commandTimeout = "1s"

[retention]
jobsMaxAge = "1ms"
jobsKeepLastPerTrigger = 0
jobsGcMs = 20
`,
      );
      await store.saveJob(oldTerminalJob("old-terminal"));
      await store.saveJob(freshRunningJob("still-running"));

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        const gc = await waitForLedgerEvent(store, "pollinate.jobs.gc");
        expect(gc.deleted).toBe(1);

        expect(await store.getJob("old-terminal")).toBeNull();
        const stillThere = await store.getJob("still-running");
        expect(stillThere).not.toBeNull();
        expect(stillThere?.status).toBe("running");
      } finally {
        await daemon.stop();
      }
    });
  });

  test("rotates ledger.jsonl once it exceeds retention.ledgerMaxMb", async () => {
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
contextTimeout = "1s"
commandTimeout = "1s"

[retention]
jobsMaxAge = "14d"
jobsGcMs = 20
ledgerMaxMb = 0.00001
`,
      );

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        await waitForLedgerEvent(store, "pollinate.ledger.rotated");
        const stat = await import("node:fs/promises").then((fs) => fs.stat(`${ledgerPath(root)}.1`));
        expect(stat.isFile()).toBe(true);
      } finally {
        await daemon.stop();
      }
    });
  });
});
