import { describe, expect, test } from "vitest";
import { ActionExecutor } from "../src/actions.js";
import { parseTriggerToml, triggerToToml } from "../src/config.js";
import { DeliveryManager } from "../src/delivery.js";
import { nextCronFireAfter, nextFireAfter, ScheduleEngine } from "../src/schedule.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

type CronCase = {
  name: string;
  expression: string;
  after: string;
  expected: string;
  timezone?: string;
  previousFireAt?: string;
};

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

  test("parses sequence actions for router swarms", () => {
    const trigger = parseTriggerToml(`
[trigger]
id = "github-pr-swarm"
name = "GitHub PR swarm"
enabled = true

[trigger.source]
kind = "webhook"
[trigger.source.webhook]
path = "github/pr"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 4

[trigger.router]
plugin = "github-pr"
openOn = ["github.pull_request.opened"]
closeOn = ["github.pull_request.closed"]

[trigger.router.onOpen]
kind = "sequence"
mode = "parallel"
primary = "claude"

[[trigger.router.onOpen.actions]]
id = "claude"
kind = "honeybee"
run = "spawn"
bee = "claude"
name = "claude-{{pr_number}}"

[[trigger.router.onOpen.actions]]
id = "grok"
kind = "honeybee"
run = "spawn"
bee = "grok"
name = "grok-{{pr_number}}"

[trigger.router.onActivity]
kind = "sequence"
mode = "parallel"

[[trigger.router.onActivity.actions]]
id = "claude"
kind = "honeybee"
run = "send"
target = "{{binding.targets.claude}}"
message = "{{activity_markdown}}"

[[trigger.router.onActivity.actions]]
id = "grok"
kind = "honeybee"
run = "send"
target = "{{binding.targets.grok}}"
message = "{{activity_markdown}}"
`);

    expect(trigger.router?.onOpen.kind).toBe("sequence");
    if (trigger.router?.onOpen.kind !== "sequence") throw new Error("expected sequence");
    expect(trigger.router.onOpen.actions.map((step) => step.id)).toEqual(["claude", "grok"]);
    expect(triggerToToml(trigger)).toContain('kind = "sequence"');
  });

  test("computes cron and interval next fires", () => {
    const next = nextCronFireAfter("0 8 * * 1-5", new Date("2026-06-08T05:59:00.000Z"), "Europe/Oslo");
    expect(next.toISOString()).toBe("2026-06-08T06:00:00.000Z");

    const interval = nextFireAfter({ type: "every", interval: "5m" }, new Date("2026-06-08T06:00:00.000Z"));
    expect(interval.toISOString()).toBe("2026-06-08T06:05:00.000Z");

    const once = nextFireAfter({ type: "once", at: "2026-06-08T06:01:00.000Z" }, new Date("2026-06-08T06:00:00.000Z"));
    expect(once.toISOString()).toBe("2026-06-08T06:01:00.000Z");
  });

  test.each<CronCase>([
    {
      name: "minute steps",
      expression: "*/20 * * * *",
      after: "2026-06-08T06:01:00.000Z",
      expected: "2026-06-08T06:20:00.000Z",
    },
    {
      name: "comma lists",
      expression: "5,20,50 6 * * *",
      after: "2026-06-08T06:06:00.000Z",
      expected: "2026-06-08T06:20:00.000Z",
    },
    {
      name: "day-of-week ranges",
      expression: "0 9 * * 1-5",
      after: "2026-06-13T09:00:00.000Z",
      expected: "2026-06-15T09:00:00.000Z",
    },
    {
      name: "day-of-week 7 is Sunday",
      expression: "0 10 * * 7",
      after: "2026-06-06T10:00:00.000Z",
      expected: "2026-06-07T10:00:00.000Z",
    },
    {
      name: "DOM-or-DOW fires on a matching day of month",
      expression: "0 9 15 * 1",
      after: "2026-07-14T08:59:00.000Z",
      expected: "2026-07-15T09:00:00.000Z",
    },
    {
      name: "DOM-or-DOW fires on a matching day of week",
      expression: "0 9 15 * 1",
      after: "2026-06-16T08:59:00.000Z",
      expected: "2026-06-22T09:00:00.000Z",
    },
    {
      name: "Europe/Oslo spring-forward skipped local minute",
      expression: "30 2 * * *",
      after: "2026-03-29T00:55:00.000Z",
      timezone: "Europe/Oslo",
      expected: "2026-03-29T01:00:00.000Z",
    },
    {
      name: "Europe/Oslo fall-back duplicate local minute",
      expression: "30 2 * * *",
      after: "2026-10-25T00:30:00.000Z",
      previousFireAt: "2026-10-25T00:30:00.000Z",
      timezone: "Europe/Oslo",
      expected: "2026-10-26T01:30:00.000Z",
    },
  ])("computes cron next fires for $name", ({ expression, after, expected, timezone, previousFireAt }) => {
    const next = nextCronFireAfter(
      expression,
      new Date(after),
      timezone ?? "UTC",
      previousFireAt ? { previousFireAt: new Date(previousFireAt) } : {},
    );
    expect(next.toISOString()).toBe(expected);
  });

  test.each([
    { name: "too few fields", expression: "* * * *" },
    { name: "zero step", expression: "*/0 * * * *" },
    { name: "minute above range", expression: "60 * * * *" },
    { name: "reversed range", expression: "10-5 * * * *" },
    { name: "day-of-week above seven", expression: "* * * * 8" },
  ])("throws for invalid cron expression: $name", ({ expression }) => {
    expect(() => nextCronFireAfter(expression, new Date("2026-06-08T06:00:00.000Z"))).toThrow();
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
      const at = new Date(Date.now() + 200).toISOString();
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
        const [job] = await waitForTerminalJobs(store, 1, 2_000);
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

  test("missed-fire policy fire-all catches up every missed interval", async () => {
    await withTempStore(async (store) => {
      const intervalMs = 60 * 60_000;
      const firstMissed = new Date(Date.now() - 3 * intervalMs + 60_000);
      const expectedScheduledAts = [0, 1, 2].map((offset) => new Date(firstMissed.getTime() + offset * intervalMs).toISOString());
      const trig = trigger({
        id: "fire-all",
        source: { kind: "schedule", timing: { type: "every", interval: "1h", missedFirePolicy: "fire-all" } },
      });
      await store.saveTrigger(trig);
      await store.writeScheduleState({
        "fire-all": { nextFireAt: firstMissed.toISOString() },
      });
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([trig]);
      const schedule = new ScheduleEngine(store, delivery, [trig], 10);
      await schedule.start();
      try {
        const jobs = await waitForTerminalJobs(store, 3, 1_000);
        const fireAllJobs = jobs.filter((job) => job.triggerId === "fire-all");
        expect(fireAllJobs).toHaveLength(3);
        expect(fireAllJobs.map((job) => (job.batch[0] as { scheduled_at: string }).scheduled_at).sort()).toEqual(expectedScheduledAts);
        expect((await store.readScheduleState())["fire-all"]?.nextFireAt).toBe(new Date(firstMissed.getTime() + 3 * intervalMs).toISOString());
      } finally {
        await schedule.stop();
        await delivery.shutdown();
      }
    });
  });
});
