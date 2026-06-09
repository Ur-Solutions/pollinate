import { describe, expect, test } from "vitest";
import { ActionExecutor, DeliveryManager, parseTriggerToml, triggerToToml, nextCronFireAfter, nextFireAfter, ScheduleEngine } from "../src/index.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

describe("config and schedule parsing", () => {
  test("parses PRD-style TOML trigger config", () => {
    const trigger = parseTriggerToml(`
[trigger]
name = "telegram-inbound"
enabled = true
cwd = "/tmp/pollinate-repo"
tags = ["chat"]

[trigger.source]
kind = "webhook"
[trigger.source.webhook]
path = "telegram"
secret = "env:POLLINATE_TELEGRAM_SECRET"
[trigger.source.webhook.transform]
text = "$.message.text"
chat_id = "$.message.chat.id"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 4

[trigger.action]
kind = "hermes"
invoke = "respond-to-message"
payload = '{"text":"{{text}}","chat":"{{chat_id}}"}'
`);
    expect(trigger.id).toBe("telegram-inbound");
    expect(trigger.source.kind).toBe("webhook");
    expect(trigger.cwd).toBe("/tmp/pollinate-repo");
    expect(trigger.delivery.maxConcurrent).toBe(4);
    expect(trigger.action.kind).toBe("hermes");
    expect(triggerToToml(trigger)).toContain('cwd = "/tmp/pollinate-repo"');
  });

  test("computes cron and interval next fires", () => {
    const next = nextCronFireAfter("0 8 * * 1-5", new Date("2026-06-08T05:59:00.000Z"), "Europe/Oslo");
    expect(next.toISOString()).toBe("2026-06-08T06:00:00.000Z");

    const interval = nextFireAfter({ type: "every", interval: "5m" }, new Date("2026-06-08T06:00:00.000Z"));
    expect(interval.toISOString()).toBe("2026-06-08T06:05:00.000Z");

    const once = nextFireAfter({ type: "once", at: "2026-06-08T06:01:00.000Z" }, new Date("2026-06-08T06:00:00.000Z"));
    expect(once.toISOString()).toBe("2026-06-08T06:01:00.000Z");
  });

  test("every schedules fire repeatedly", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "every",
        source: { kind: "schedule", timing: { type: "every", interval: "40ms" } },
      });
      await store.saveTrigger(trig);
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([trig]);
      const schedule = new ScheduleEngine(store, delivery, [trig], 10);
      await schedule.start();
      try {
        const jobs = await waitForTerminalJobs(store, 2, 1_000);
        expect(jobs.filter((job) => job.triggerId === "every")).toHaveLength(2);
      } finally {
        await schedule.stop();
        await delivery.shutdown();
      }
    });
  });

  test("once schedules fire then disable the trigger", async () => {
    await withTempStore(async (store) => {
      const at = new Date(Date.now() + 30).toISOString();
      const trig = trigger({
        id: "once",
        source: { kind: "schedule", timing: { type: "once", at } },
      });
      await store.saveTrigger(trig);
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([trig]);
      const schedule = new ScheduleEngine(store, delivery, [trig], 10);
      await schedule.start();
      try {
        const [job] = await waitForTerminalJobs(store, 1, 1_000);
        expect(job.triggerId).toBe("once");
        expect((await store.requireTrigger("once")).enabled).toBe(false);
      } finally {
        await schedule.stop();
        await delivery.shutdown();
      }
    });
  });

  test("missed-fire policy skips by default and can fire once", async () => {
    await withTempStore(async (store) => {
      const skipped = trigger({
        id: "skip",
        source: { kind: "schedule", timing: { type: "every", interval: "1h" } },
      });
      const catchup = trigger({
        id: "catchup",
        source: { kind: "schedule", timing: { type: "every", interval: "1h", missedFirePolicy: "fire-once" } },
      });
      await store.saveTrigger(skipped);
      await store.saveTrigger(catchup);
      await store.writeScheduleState({
        skip: { nextFireAt: new Date(Date.now() - 60_000).toISOString() },
        catchup: { nextFireAt: new Date(Date.now() - 60_000).toISOString() },
      });
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([skipped, catchup]);
      const schedule = new ScheduleEngine(store, delivery, [skipped, catchup], 10);
      await schedule.start();
      try {
        const [job] = await waitForTerminalJobs(store, 1, 1_000);
        expect(job.triggerId).toBe("catchup");
        expect((await store.listJobs()).filter((item) => item.triggerId === "skip")).toHaveLength(0);
      } finally {
        await schedule.stop();
        await delivery.shutdown();
      }
    });
  });
});
