import { describe, expect, test } from "vitest";
import {
  allocateJobIdentity,
  jobPrefixForTrigger,
  matchesJobReference,
  minimumUniqueUuidPrefixLength,
  type Job,
} from "../src/index.js";
import { trigger, withTempStore } from "./helpers.js";

describe("job ids", () => {
  test("derive a Honeybee-style prefix from the trigger id", () => {
    expect(jobPrefixForTrigger(trigger({ id: "github-push" }))).toBe("GI.");
    expect(jobPrefixForTrigger(trigger({ id: "x" }))).toBe("XX.");
  });

  test("choose the minimum globally unique UUID prefix from sorted neighbors", () => {
    const used = [
      "abc00000000040008000000000000000",
      "abd00000000040008000000000000000",
      "fff00000000040008000000000000000",
    ];

    expect(minimumUniqueUuidPrefixLength("abc11111111141118111111111111111", used)).toBe(4);
    expect(minimumUniqueUuidPrefixLength("def11111111141118111111111111111", used)).toBe(3);
  });

  test("allocates visible ids with globally unique suffixes that grow across triggers", async () => {
    await withTempStore(async (_store, root) => {
      const first = await allocateJobIdentity({
        root,
        trigger: trigger({ id: "hello" }),
        uuid: () => "abc00000-0000-4000-8000-000000000000",
      });
      const second = await allocateJobIdentity({
        root,
        trigger: trigger({ id: "worker" }),
        uuid: () => "abc11111-1111-4111-8111-111111111111",
      });

      expect(first).toEqual({
        id: "HE.abc",
        idPrefix: "HE.",
        uuid: "abc00000000040008000000000000000",
      });
      expect(second).toEqual({
        id: "WO.abc1",
        idPrefix: "WO.",
        uuid: "abc11111111141118111111111111111",
      });
    });
  });

  test("resolves jobs by visible id, longer UUID prefixes, and suffixes", async () => {
    await withTempStore(async (store, root) => {
      const trig = trigger({ id: "hello" });
      const identity = await allocateJobIdentity({
        root,
        trigger: trig,
        uuid: () => "abc00000-0000-4000-8000-000000000000",
      });
      const job = jobFromIdentity(identity, trig.id);
      await store.saveJob(job);

      expect((await store.getJob("HE.abc"))?.id).toBe("HE.abc");
      expect((await store.getJob("HE.abc0"))?.id).toBe("HE.abc");
      expect((await store.getJob("abc"))?.id).toBe("HE.abc");
      expect(await store.getJob("ab")).toBeNull();
      expect(matchesJobReference(job, "abc0")).toBe(true);

      const cancelled = await store.cancelJob("abc");
      expect(cancelled.id).toBe("HE.abc");
      expect((await store.readLedger()).at(-1)).toContain('"job_id":"HE.abc"');
    });
  });

  test("seeds the temporal uniqueness index from legacy UUID job files", async () => {
    await withTempStore(async (store, root) => {
      await store.saveJob(jobFromIdentity(
        {
          id: "abc00000-0000-4000-8000-000000000000",
          idPrefix: "",
          uuid: "abc00000000040008000000000000000",
        },
        "legacy",
      ));

      const next = await allocateJobIdentity({
        root,
        trigger: trigger({ id: "new-job" }),
        uuid: () => "abc11111-1111-4111-8111-111111111111",
      });

      expect(next.id).toBe("NE.abc1");
    });
  });
});

function jobFromIdentity(identity: { id: string; idPrefix?: string; uuid?: string }, triggerId: string): Job {
  return {
    id: identity.id,
    idPrefix: identity.idPrefix,
    uuid: identity.uuid,
    triggerId,
    source: "manual",
    status: "queued",
    context: {},
    action: { kind: "emit", subject: "test" },
    queuedAt: new Date().toISOString(),
  };
}
