import { readdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Job } from "../src/index.js";
import { withTempStore } from "./helpers.js";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "JO.aaa",
    triggerId: "t1",
    source: "manual",
    status: "completed",
    context: {},
    queuedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-06-19T00:00:00.000Z");

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

describe("listJobs", () => {
  test("returns the most recent N when last is set, newest first", async () => {
    await withTempStore(async (store) => {
      for (let i = 0; i < 5; i += 1) {
        await store.saveJob(job({ id: `JO.${i}`, queuedAt: iso((5 - i) * HOUR) }));
      }
      const recent = await store.listJobs({ last: 2 });
      expect(recent.map((j) => j.id)).toEqual(["JO.4", "JO.3"]);
    });
  });

  test("honours status and trigger filters", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "JO.a", status: "running", triggerId: "t1", queuedAt: iso(3 * HOUR) }));
      await store.saveJob(job({ id: "JO.b", status: "completed", triggerId: "t1", queuedAt: iso(2 * HOUR) }));
      await store.saveJob(job({ id: "JO.c", status: "completed", triggerId: "t2", queuedAt: iso(1 * HOUR) }));

      expect((await store.listJobs({ status: "completed" })).map((j) => j.id)).toEqual(["JO.c", "JO.b"]);
      expect((await store.listJobs({ triggerId: "t2" })).map((j) => j.id)).toEqual(["JO.c"]);
    });
  });

  test("countJobs counts files without parsing", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "JO.a" }));
      await store.saveJob(job({ id: "JO.b" }));
      expect(await store.countJobs()).toBe(2);
    });
  });
});

describe("archiveJobs", () => {
  test("archives terminal jobs older than the retention window", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "JO.old", status: "completed", completedAt: iso(10 * DAY), queuedAt: iso(10 * DAY) }));
      await store.saveJob(job({ id: "JO.new", status: "completed", completedAt: iso(1 * HOUR), queuedAt: iso(1 * HOUR) }));

      const result = await store.archiveJobs({ retention: "7d", now: NOW });
      expect(result).toEqual({ archived: 1, scanned: 2 });

      const live = (await store.listJobs()).map((j) => j.id);
      expect(live).toEqual(["JO.new"]);
      // The archived job is still resolvable by id.
      expect((await store.getJob("JO.old"))?.id).toBe("JO.old");
    });
  });

  test("never archives in-flight jobs even when old", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "JO.run", status: "running", queuedAt: iso(30 * DAY) }));
      const result = await store.archiveJobs({ retention: "7d", now: NOW });
      expect(result.archived).toBe(0);
      expect((await store.listJobs()).map((j) => j.id)).toEqual(["JO.run"]);
    });
  });

  test("archives terminal jobs beyond the count cap, keeping the newest", async () => {
    await withTempStore(async (store) => {
      for (let i = 0; i < 5; i += 1) {
        await store.saveJob(job({ id: `JO.${i}`, status: "completed", completedAt: iso((5 - i) * HOUR), queuedAt: iso((5 - i) * HOUR) }));
      }
      const result = await store.archiveJobs({ maxJobs: 2, now: NOW });
      expect(result.archived).toBe(3);
      expect((await store.listJobs()).map((j) => j.id)).toEqual(["JO.4", "JO.3"]);
    });
  });

  test("dry-run reports counts without touching files", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "JO.old", status: "completed", completedAt: iso(10 * DAY), queuedAt: iso(10 * DAY) }));
      const result = await store.archiveJobs({ retention: "7d", now: NOW, dryRun: true });
      expect(result.archived).toBe(1);
      expect(await store.countJobs()).toBe(1);
    });
  });

  test("ledgers an archived event when jobs are pruned", async () => {
    await withTempStore(async (store) => {
      await store.saveJob(job({ id: "JO.old", status: "completed", completedAt: iso(10 * DAY), queuedAt: iso(10 * DAY) }));
      await store.archiveJobs({ retention: "7d", now: NOW });
      const ledger = await store.readLedger();
      const archived = ledger.map((line) => JSON.parse(line)).find((entry) => entry.event === "pollinate.job.archived");
      expect(archived).toMatchObject({ count: 1, scanned: 1 });
    });
  });

  test("the archive file is not picked up as a live job", async () => {
    await withTempStore(async (store, root) => {
      await store.saveJob(job({ id: "JO.old", status: "completed", completedAt: iso(10 * DAY), queuedAt: iso(10 * DAY) }));
      await store.archiveJobs({ retention: "7d", now: NOW });
      const files = await readdir(`${root}/jobs`);
      expect(files).toContain("archive.jsonl");
      expect(await store.countJobs()).toBe(0);
    });
  });
});
