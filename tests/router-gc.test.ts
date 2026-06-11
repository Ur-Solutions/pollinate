import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActionExecutor, gcRouterBindings, routerGcSummary, routerPluginsDir, type RouterBinding, type Trigger } from "../src/index.js";
import { writeFile } from "node:fs/promises";
import { installCommandStub, installHiveStub, trigger, withTempStore } from "./helpers.js";

function routerTrigger(overrides: Partial<Trigger> = {}, routerOverrides: Partial<NonNullable<Trigger["router"]>> = {}): Trigger {
  return trigger({
    id: "gc-router",
    source: { kind: "webhook", webhook: { path: "gc/pr" } },
    action: undefined,
    router: {
      plugin: "github-pr",
      openOn: ["github.pull_request.opened"],
      closeOn: ["github.pull_request.merged"],
      onOpen: { kind: "honeybee", run: "spawn", bee: "codex", name: "pr-{{pr_number}}" },
      onActivity: { kind: "honeybee", run: "send", target: "{{binding.target}}", message: "{{activity_markdown}}" },
      ...routerOverrides,
    },
    ...overrides,
  });
}

function binding(triggerId: string, overrides: Partial<RouterBinding> = {}): RouterBinding {
  const now = new Date().toISOString();
  return {
    id: `${triggerId}.github:pull_request:trmd-demo#5`,
    triggerId,
    router: "github-pr",
    subjectKey: "github:pull_request:trmd/demo#5",
    status: "active",
    target: { kind: "hive", handle: "pr-5" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("router binding gc", () => {
  test("closes active bindings whose idleTtl elapsed and kills the bound bee", async () => {
    await withTempStore(async (store) => {
      const hive = await installHiveStub(store.root);
      try {
        const trig = routerTrigger({}, { idleTtl: "1s" });
        await store.saveTrigger(trig);
        await store.saveRouterBinding(binding(trig.id, { updatedAt: isoAgo(60_000), lastActivityAt: isoAgo(60_000) }));
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });

        const result = await gcRouterBindings({ store, executor, triggers: [trig] });

        expect(result.expired).toHaveLength(1);
        const updated = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(updated?.status).toBe("closed");
        expect(await hive.log()).toContain("kill pr-5");
        const ledger = (await store.readLedger()).join("\n");
        expect(ledger).toContain("pollinate.router.binding_expired");
        expect(ledger).toContain("idle-ttl");
      } finally {
        hive.restore();
      }
    });
  });

  test("leaves recently active bindings alone", async () => {
    await withTempStore(async (store) => {
      const hive = await installHiveStub(store.root);
      try {
        const trig = routerTrigger({}, { idleTtl: "1h" });
        await store.saveTrigger(trig);
        await store.saveRouterBinding(binding(trig.id, { lastActivityAt: isoAgo(1_000) }));
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });

        const result = await gcRouterBindings({ store, executor, triggers: [trig] });

        expect(routerGcSummary(result)).toBeUndefined();
        const updated = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(updated?.status).toBe("active");
        expect(await hive.log()).toBe("");
      } finally {
        hive.restore();
      }
    });
  });

  test("retries errored bindings using the stored open context", async () => {
    await withTempStore(async (store) => {
      const hive = await installHiveStub(store.root);
      try {
        const trig = routerTrigger();
        await store.saveTrigger(trig);
        await store.saveRouterBinding(
          binding(trig.id, {
            status: "errored",
            target: undefined,
            error: "hive spawn exited 1: transient",
            openAttempts: 1,
            context: { pr_number: "5", repo: "trmd/demo" },
          }),
        );
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });

        const result = await gcRouterBindings({ store, executor, triggers: [trig] });

        expect(result.retried).toHaveLength(1);
        const updated = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(updated).toMatchObject({ status: "active", target: { handle: "pr-5" } });
        expect(await hive.log()).toContain("spawn codex --name pr-5");
        expect((await store.readLedger()).join("\n")).toContain("pollinate.router.binding_retry");
      } finally {
        hive.restore();
      }
    });
  });

  test("abandons errored bindings once open retries are exhausted", async () => {
    await withTempStore(async (store) => {
      const hive = await installHiveStub(store.root);
      try {
        const trig = routerTrigger();
        await store.saveTrigger(trig);
        await store.saveRouterBinding(
          binding(trig.id, {
            status: "errored",
            target: undefined,
            error: "hive spawn exited 1: persistent",
            openAttempts: 4,
            context: { pr_number: "5", repo: "trmd/demo" },
          }),
        );
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });

        const result = await gcRouterBindings({ store, executor, triggers: [trig], maxOpenRetries: 3 });

        expect(result.abandoned).toHaveLength(1);
        const updated = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(updated?.status).toBe("closed");
        expect(await hive.log()).toBe("");
        expect((await store.readLedger()).join("\n")).toContain("open-retries-exhausted");
      } finally {
        hive.restore();
      }
    });
  });

  test("marks stale pending bindings errored so the retry pass can re-drive them", async () => {
    await withTempStore(async (store) => {
      const hive = await installHiveStub(store.root);
      try {
        const trig = routerTrigger();
        await store.saveTrigger(trig);
        await store.saveRouterBinding(
          binding(trig.id, {
            status: "pending",
            target: undefined,
            updatedAt: isoAgo(3_600_000),
            context: { pr_number: "5", repo: "trmd/demo" },
          }),
        );
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });

        const first = await gcRouterBindings({ store, executor, triggers: [trig] });
        expect(first.staled).toHaveLength(1);
        const errored = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(errored?.status).toBe("errored");

        const second = await gcRouterBindings({ store, executor, triggers: [trig] });
        expect(second.retried).toHaveLength(1);
        const recovered = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(recovered).toMatchObject({ status: "active", target: { handle: "pr-5" } });
      } finally {
        hive.restore();
      }
    });
  });

  test("reconciles github-pr bindings against gh pr state and closes merged PRs", async () => {
    await withTempStore(async (store) => {
      const hive = await installHiveStub(store.root);
      const ghLog = join(store.root, "gh.log");
      await installCommandStub(store.root, "gh", `#!/bin/sh\necho "$@" >> "${ghLog}"\nprintf '{"state":"MERGED"}\\n'\ncat >/dev/null\n`, ghLog);
      try {
        const trig = routerTrigger();
        await store.saveTrigger(trig);
        await store.saveRouterBinding(binding(trig.id, { lastActivityAt: isoAgo(3_600_000), updatedAt: isoAgo(3_600_000) }));
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });

        const result = await gcRouterBindings({ store, executor, triggers: [trig], reconcileAfterMs: 0 });

        expect(result.reconciled).toHaveLength(1);
        const updated = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(updated?.status).toBe("closed");
        expect(await hive.log()).toContain("kill pr-5");
        expect(await store.readLedger().then((lines) => lines.join("\n"))).toContain("pollinate.router.binding_reconciled");
        const gh = await import("node:fs/promises").then((fs) => fs.readFile(ghLog, "utf8"));
        expect(gh).toContain("pr view 5 --repo trmd/demo --json state");
      } finally {
        hive.restore();
      }
    });
  });

  test("keeps open PRs bound and stamps checkedAt", async () => {
    await withTempStore(async (store) => {
      const hive = await installHiveStub(store.root);
      const ghLog = join(store.root, "gh.log");
      await installCommandStub(store.root, "gh", `#!/bin/sh\necho "$@" >> "${ghLog}"\nprintf '{"state":"OPEN"}\\n'\ncat >/dev/null\n`, ghLog);
      try {
        const trig = routerTrigger();
        await store.saveTrigger(trig);
        await store.saveRouterBinding(binding(trig.id, { lastActivityAt: isoAgo(3_600_000), updatedAt: isoAgo(3_600_000) }));
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });

        const result = await gcRouterBindings({ store, executor, triggers: [trig], reconcileAfterMs: 0 });

        expect(routerGcSummary(result)).toBeUndefined();
        const updated = await store.getRouterBinding(trig.id, "github:pull_request:trmd/demo#5");
        expect(updated?.status).toBe("active");
        expect(updated?.checkedAt).toBeDefined();
        expect(await hive.log()).toBe("");
      } finally {
        hive.restore();
      }
    });
  });

  test("user-space plugins can opt into reconciliation via subjectState", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(store.root);
      try {
        await writeFile(
          join(routerPluginsDir(root), "always-closed.mjs"),
          `export default {
  name: "always-closed",
  normalize() { return []; },
  subjectState() { return "closed"; },
};
`,
        );
        const trig = routerTrigger({ id: "custom-gc" }, { plugin: "always-closed" });
        await store.saveTrigger(trig);
        await store.saveRouterBinding(
          binding(trig.id, {
            router: "always-closed",
            subjectKey: "custom:thing#1",
            id: "custom-gc.custom:thing#1",
            target: { kind: "hive", handle: "thing-1" },
            lastActivityAt: isoAgo(3_600_000),
            updatedAt: isoAgo(3_600_000),
          }),
        );
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });

        const result = await gcRouterBindings({ store, executor, triggers: [trig], reconcileAfterMs: 0 });

        expect(result.reconciled).toHaveLength(1);
        const updated = await store.getRouterBinding(trig.id, "custom:thing#1");
        expect(updated?.status).toBe("closed");
        expect(await hive.log()).toContain("kill thing-1");
      } finally {
        hive.restore();
      }
    });
  });
});
