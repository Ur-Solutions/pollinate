import { stat } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { ledgerPath, rotateLedgerIfLarge, type Job, type JobStatus } from "../src/index.js";
import { withTempStore } from "./helpers.js";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function job(overrides: Partial<Job> & { id: string; triggerId: string; status: JobStatus }): Job {
  const now = new Date().toISOString();
  return {
    source: "manual",
    context: {},
    queuedAt: now,
    ...overrides,
  };
}

const DAY = 86_400_000;

describe("PollinateStore.garbageCollectJobs", () => {
  test("removes terminal jobs past max-age, keeping the newest N per trigger regardless of age", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "t1-oldest", triggerId: "t1", status: "completed", queuedAt: isoAgo(30 * DAY), completedAt: isoAgo(30 * DAY) }));
      await store.saveJob(job({ id: "t1-older", triggerId: "t1", status: "errored", queuedAt: isoAgo(25 * DAY), completedAt: isoAgo(25 * DAY) }));
      await store.saveJob(job({ id: "t1-newest", triggerId: "t1", status: "cancelled", queuedAt: isoAgo(20 * DAY), completedAt: isoAgo(20 * DAY) }));
      // Different trigger: its own newest-1 floor is independent of t1's — both of
      // t2's jobs are old, but the newer one is still protected by keepLastPerTrigger.
      await store.saveJob(job({ id: "t2-oldest", triggerId: "t2", status: "completed", queuedAt: isoAgo(40 * DAY), completedAt: isoAgo(40 * DAY) }));
      await store.saveJob(job({ id: "t2-newest", triggerId: "t2", status: "completed", queuedAt: isoAgo(25 * DAY), completedAt: isoAgo(25 * DAY) }));

      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 1 });

      expect(result.deletedJobIds.sort()).toEqual(["t1-older", "t1-oldest", "t2-oldest"]);
      expect(result.deleted).toBe(3);
      expect(result.perTrigger.t1).toEqual({ deleted: 2, kept: 1 });
      expect(result.perTrigger.t2).toEqual({ deleted: 1, kept: 1 });

      expect(await store.getJob("t1-newest")).not.toBeNull();
      expect(await store.getJob("t1-oldest")).toBeNull();
      expect(await store.getJob("t1-older")).toBeNull();
      expect(await store.getJob("t2-newest")).not.toBeNull();
      expect(await store.getJob("t2-oldest")).toBeNull();
    });
  });

  test("never removes queued, resolving-context, or running jobs no matter how old", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "still-queued", triggerId: "t1", status: "queued", queuedAt: isoAgo(90 * DAY) }));
      await store.saveJob(job({ id: "still-running", triggerId: "t1", status: "running", queuedAt: isoAgo(90 * DAY) }));
      await store.saveJob(job({ id: "resolving", triggerId: "t1", status: "resolving-context", queuedAt: isoAgo(90 * DAY) }));
      await store.saveJob(job({ id: "old-terminal", triggerId: "t1", status: "completed", queuedAt: isoAgo(90 * DAY), completedAt: isoAgo(90 * DAY) }));

      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 1 });

      expect(result.deletedJobIds).toEqual(["old-terminal"]);
      expect(await store.getJob("still-queued")).not.toBeNull();
      expect(await store.getJob("still-running")).not.toBeNull();
      expect(await store.getJob("resolving")).not.toBeNull();
      expect(await store.getJob("old-terminal")).toBeNull();
      // Active jobs never enter the terminal-only per-trigger breakdown.
      expect(result.perTrigger.t1).toEqual({ deleted: 1, kept: 0 });
    });
  });

  test("dry-run reports what would be removed without deleting anything", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "would-go", triggerId: "t1", status: "completed", queuedAt: isoAgo(30 * DAY), completedAt: isoAgo(30 * DAY) }));
      await store.saveJob(job({ id: "would-stay", triggerId: "t1", status: "completed", queuedAt: isoAgo(1 * DAY), completedAt: isoAgo(1 * DAY) }));

      const result = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 0, dryRun: true });

      expect(result.deletedJobIds).toEqual(["would-go"]);
      expect(result.prunedJobUuids).toBe(0);
      // Nothing was actually unlinked.
      expect(await store.getJob("would-go")).not.toBeNull();
      expect(await store.getJob("would-stay")).not.toBeNull();

      const rerun = await store.garbageCollectJobs({ terminalOlderThanDays: 14, keepLastPerTrigger: 0 });
      expect(rerun.deletedJobIds).toEqual(["would-go"]);
      expect(await store.getJob("would-go")).toBeNull();
    });
  });

  test("rejects a non-positive retention window", async () => {
    await withTempStore(async (store) => {
      await expect(store.garbageCollectJobs({ terminalOlderThanDays: 0 })).rejects.toThrow(/terminalOlderThanDays/);
    });
  });
});

describe("PollinateStore.listJobs statuses filter", () => {
  test("filters before collecting, and matches the equivalent single-status query", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "queued-1", triggerId: "t1", status: "queued" }));
      await store.saveJob(job({ id: "running-1", triggerId: "t1", status: "running" }));
      await store.saveJob(job({ id: "done-1", triggerId: "t1", status: "completed", completedAt: new Date().toISOString() }));

      const nonTerminal = await store.listJobs({ statuses: ["queued", "resolving-context", "running"] });
      expect(nonTerminal.map((j) => j.id).sort()).toEqual(["queued-1", "running-1"]);

      const onlyQueued = await store.listJobs({ statuses: ["queued"] });
      expect(onlyQueued.map((j) => j.id)).toEqual(["queued-1"]);
      expect(await store.listJobs({ status: "queued" })).toEqual(onlyQueued);
    });
  });
});

describe("rotateLedgerIfLarge", () => {
  test("leaves a ledger under the size cap untouched", async () => {
    await withTempStore(async (store, root) => {
      await store.appendLedger({ event: "pollinate.test.small" });
      const rotated = await rotateLedgerIfLarge(root, 64);
      expect(rotated).toBe(false);
      expect((await store.readLedger()).join("\n")).toContain("pollinate.test.small");
    });
  });

  test("rotates ledger.jsonl to ledger.jsonl.1 once it exceeds the cap, replacing any prior generation", async () => {
    await withTempStore(async (store, root) => {
      await store.appendLedger({ event: "pollinate.test.first-generation" });
      // Force a rotation with a cap so small any content trips it.
      const firstRotation = await rotateLedgerIfLarge(root, 0.00001);
      expect(firstRotation).toBe(true);

      const rotatedContent = await stat(`${ledgerPath(root)}.1`);
      expect(rotatedContent.isFile()).toBe(true);

      // Lazily recreated on the next append; old content isn't visible via readLedger.
      await store.appendLedger({ event: "pollinate.test.second-generation" });
      const lines = await store.readLedger();
      expect(lines.join("\n")).toContain("pollinate.test.second-generation");
      expect(lines.join("\n")).not.toContain("pollinate.test.first-generation");

      // Rotating again replaces the previous .1 generation instead of erroring.
      const secondRotation = await rotateLedgerIfLarge(root, 0.00001);
      expect(secondRotation).toBe(true);
      const replaced = await stat(`${ledgerPath(root)}.1`);
      expect(replaced.isFile()).toBe(true);
    });
  });

  test("is a no-op when ledger.jsonl does not exist yet", async () => {
    await withTempStore(async (_store, root) => {
      await expect(rotateLedgerIfLarge(root, 1)).resolves.toBe(false);
    });
  });
});
