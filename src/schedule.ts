import type { Activation, MissedFirePolicy, ScheduleState, ScheduleTiming, Trigger } from "./types.js";
import { DeliveryManager } from "./delivery.js";
import { PollinateStore } from "./store.js";
import { nowIso, parseDuration, parseIsoDate } from "./time.js";

export class ScheduleEngine {
  private state: ScheduleState = {};
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly store: PollinateStore,
    private readonly delivery: DeliveryManager,
    private triggers: Trigger[],
    private readonly tickMs: number,
  ) {}

  async start(): Promise<void> {
    this.state = await this.store.readScheduleState();
    this.running = true;
    await this.restoreMissedFires();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    await this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    await this.store.writeScheduleState(this.state);
  }

  updateTriggers(triggers: Trigger[]): void {
    this.triggers = triggers;
  }

  private async restoreMissedFires(): Promise<void> {
    const now = new Date();
    for (const trigger of this.scheduleTriggers()) {
      const timing = trigger.source.kind === "schedule" ? trigger.source.timing : undefined;
      if (!timing) continue;
      const entry = this.state[trigger.id];
      if (!entry?.nextFireAt) {
        this.state[trigger.id] = { ...entry, nextFireAt: nextFireAfter(timing, now).toISOString() };
        continue;
      }
      const next = parseIsoDate(entry.nextFireAt, "nextFireAt");
      if (next.getTime() > now.getTime()) continue;
      const policy = timing.missedFirePolicy ?? "skip";
      await this.store.appendLedger({ event: "pollinate.schedule.missed", trigger_id: trigger.id, policy, scheduled_at: entry.nextFireAt });
      if (policy === "skip") {
        this.state[trigger.id] = { ...entry, nextFireAt: nextFireAfter(timing, now).toISOString() };
      } else if (policy === "fire-once") {
        await this.fire(trigger);
        this.state[trigger.id] = { ...this.state[trigger.id], nextFireAt: nextFireAfter(timing, now).toISOString() };
      } else {
        let cursor = next;
        let count = 0;
        while (cursor.getTime() <= now.getTime() && count < 100) {
          await this.fire(trigger, cursor);
          cursor = nextFireAfter(timing, cursor);
          count += 1;
        }
        this.state[trigger.id] = { ...this.state[trigger.id], nextFireAt: nextFireAfter(timing, now).toISOString() };
      }
    }
    await this.store.writeScheduleState(this.state);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = new Date();
    for (const trigger of this.scheduleTriggers()) {
      const timing = trigger.source.kind === "schedule" ? trigger.source.timing : undefined;
      if (!timing) continue;
      const entry = this.state[trigger.id] ?? {};
      if (timing.type === "once" && entry.completedOnce) continue;
      const nextAt = entry.nextFireAt ? parseIsoDate(entry.nextFireAt, "nextFireAt") : initialNextFire(timing, now);
      if (!entry.nextFireAt) this.state[trigger.id] = { ...entry, nextFireAt: nextAt.toISOString() };
      if (nextAt.getTime() <= now.getTime()) {
        await this.fire(trigger, nextAt);
        if (timing.type === "once") {
          this.state[trigger.id] = { ...this.state[trigger.id], completedOnce: true, lastFireAt: nowIso(), nextFireAt: undefined };
          await this.store.setTriggerEnabled(trigger.id, false);
          trigger.enabled = false;
        } else {
          this.state[trigger.id] = { ...this.state[trigger.id], lastFireAt: nowIso(), nextFireAt: nextFireAfter(timing, now).toISOString() };
        }
        await this.store.writeScheduleState(this.state);
      }
    }
  }

  private async fire(trigger: Trigger, scheduledAt = new Date()): Promise<void> {
    const activation: Activation = {
      triggerId: trigger.id,
      source: "schedule",
      payload: { scheduled_at: scheduledAt.toISOString() },
      receivedAt: nowIso(),
    };
    const job = await this.delivery.handle(trigger, activation);
    await this.store.appendLedger({ event: "pollinate.schedule.fired", trigger_id: trigger.id, job_id: job?.id, at: nowIso() });
  }

  private scheduleTriggers(): Trigger[] {
    return this.triggers.filter((trigger) => trigger.enabled && trigger.source.kind === "schedule");
  }
}

function initialNextFire(timing: ScheduleTiming, now: Date): Date {
  if (timing.type === "once") return parseIsoDate(timing.at, "once schedule");
  return nextFireAfter(timing, now);
}

export function nextFireAfter(timing: ScheduleTiming, after: Date): Date {
  if (timing.type === "every") {
    return new Date(after.getTime() + parseDuration(timing.interval));
  }
  if (timing.type === "once") {
    const at = parseIsoDate(timing.at, "once schedule");
    return at.getTime() <= after.getTime() ? after : at;
  }
  return nextCronFireAfter(timing.expression, after, timing.timezone ?? "UTC");
}

export function nextCronFireAfter(expression: string, after: Date, timezone = "UTC"): Date {
  const fields = parseCronExpression(expression);
  const cursor = new Date(after.getTime() + 60_000);
  cursor.setUTCSeconds(0, 0);
  const deadline = new Date(after.getTime() + 366 * 24 * 60 * 60_000 * 5);
  while (cursor <= deadline) {
    const parts = zonedParts(cursor, timezone);
    if (cronMatches(fields, parts)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error(`Could not find next cron fire for "${expression}" within 5 years`);
}

type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domAny: boolean;
  dowAny: boolean;
};

type ZonedParts = {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
};

function parseCronExpression(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields: ${expression}`);
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dom, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dow.replace(/\b7\b/g, "0"), 0, 6),
    domAny: dom === "*",
    dowAny: dow === "*",
  };
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const token of field.split(",")) {
    const [rangePart, stepPart] = token.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${token}`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = Number(rawStart);
      end = Number(rawEnd);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron field "${field}"`);
    }
    for (let value = start; value <= end; value += step) out.add(value);
  }
  return out;
}

function zonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekday,
  };
}

function cronMatches(fields: CronFields, parts: ZonedParts): boolean {
  const domMatches = fields.dayOfMonth.has(parts.dayOfMonth);
  const dowMatches = fields.dayOfWeek.has(parts.dayOfWeek);
  const dayMatches = fields.domAny && fields.dowAny ? true : fields.domAny ? dowMatches : fields.dowAny ? domMatches : domMatches || dowMatches;
  return fields.minute.has(parts.minute) && fields.hour.has(parts.hour) && fields.month.has(parts.month) && dayMatches;
}

export function missedFirePolicy(timing: ScheduleTiming): MissedFirePolicy {
  return timing.missedFirePolicy ?? "skip";
}
