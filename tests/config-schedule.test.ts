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

  test("parses router trigger config without a static action", () => {
    const trigger = parseTriggerToml(`
[trigger]
id = "github-pr-events"
name = "GitHub PR events"
enabled = true

[trigger.source]
kind = "webhook"
[trigger.source.webhook]
path = "github/pr-events"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 2

[trigger.router]
plugin = "github-pr"
openOn = ["github.pull_request.opened"]
closeOn = ["github.pull_request.merged"]

[trigger.router.onOpen]
kind = "honeybee"
run = "spawn"
bee = "codex"
name = "pr-{{repo_slug}}-{{pr_number}}"
message = "Review {{repo}}#{{pr_number}}"

[trigger.router.onActivity]
kind = "honeybee"
run = "buz"
target = "{{binding.target}}"
message = "{{activity_markdown}}"

[trigger.router.onClose]
kind = "honeybee"
run = "kill"
target = "{{binding.target}}"
`);
    expect(trigger.action).toBeUndefined();
    expect(trigger.router?.plugin).toBe("github-pr");
    expect(trigger.router?.onOpen.kind).toBe("honeybee");
    expect(trigger.router?.onOpen.run).toBe("spawn");
    expect(triggerToToml(trigger)).toContain('plugin = "github-pr"');
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
