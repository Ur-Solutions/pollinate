import type { Activation, MissedFirePolicy, ScheduleState, ScheduleTiming, Trigger } from "./types.js";
import { DeliveryManager } from "./delivery.js";
import { PollinateStore } from "./store.js";
import { nowIso, parseDuration, parseIsoDate } from "./time.js";

type ScheduleEntry = ScheduleState[string] & { timingHash?: string };
type NextFireOptions = { previousFireAt?: Date };

const NEVER_FIRE = new Date("9999-12-31T23:59:59.999Z");

export class ScheduleEngine {
  private state: ScheduleState = {};
  private timer?: NodeJS.Timeout;
  private running = false;
  private ticking = false;

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
    if (this.running) void this.initializeScheduleState("updateTriggers");
  }

  private async restoreMissedFires(): Promise<void> {
    try {
      const now = new Date();
      let dirty = false;
      for (const trigger of this.scheduleTriggers()) {
        try {
          const timing = trigger.source.kind === "schedule" ? trigger.source.timing : undefined;
          if (!timing) continue;
          dirty = this.ensureStateForTrigger(trigger, timing, now) || dirty;
          const entry = this.entry(trigger.id);
          if (timing.type === "once" && entry.completedOnce) continue;
          if (!entry.nextFireAt) continue;
          const next = parseIsoDate(entry.nextFireAt, "nextFireAt");
          if (next.getTime() > now.getTime()) continue;
          await this.ledgerMissed(trigger, timing, entry.nextFireAt);
          await this.handleMissedFire(trigger, timing, next, now);
          dirty = false;
        } catch (error) {
          await this.ledgerScheduleError("restoreMissedFires", error, trigger.id);
        }
      }
      if (dirty) await this.store.writeScheduleState(this.state);
    } catch (error) {
      await this.ledgerScheduleError("restoreMissedFires", error);
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      for (const trigger of this.scheduleTriggers()) {
        try {
          const timing = trigger.source.kind === "schedule" ? trigger.source.timing : undefined;
          if (!timing) continue;
          if (this.ensureStateForTrigger(trigger, timing, now)) await this.store.writeScheduleState(this.state);
          const entry = this.entry(trigger.id);
          if (timing.type === "once" && entry.completedOnce) continue;
          if (!entry.nextFireAt) continue;
          const nextAt = parseIsoDate(entry.nextFireAt, "nextFireAt");
          if (nextAt.getTime() > now.getTime()) continue;
          if (this.isDuplicateCronWallTime(timing, nextAt, entry.lastFireAt)) {
            this.setEntry(trigger.id, {
              ...entry,
              nextFireAt: nextFireAfter(timing, nextAt, { previousFireAt: parseIsoDate(entry.lastFireAt!, "lastFireAt") }).toISOString(),
              timingHash: timingHash(timing),
            });
            await this.store.writeScheduleState(this.state);
            continue;
          }
          if (isMissedInTick(timing, nextAt, now)) {
            await this.ledgerMissed(trigger, timing, entry.nextFireAt);
            await this.handleMissedFire(trigger, timing, nextAt, now);
            continue;
          }
          await this.reserveAndFire(trigger, timing, nextAt, this.nextAfterScheduled(timing, nextAt));
        } catch (error) {
          await this.ledgerScheduleError("tick", error, trigger.id);
        }
      }
    } catch (error) {
      await this.ledgerScheduleError("tick", error);
    } finally {
      this.ticking = false;
    }
  }

  private async initializeScheduleState(stage: string): Promise<void> {
    try {
      const now = new Date();
      let dirty = false;
      for (const trigger of this.scheduleTriggers()) {
        try {
          const timing = trigger.source.kind === "schedule" ? trigger.source.timing : undefined;
          if (timing) dirty = this.ensureStateForTrigger(trigger, timing, now) || dirty;
        } catch (error) {
          await this.ledgerScheduleError(stage, error, trigger.id);
        }
      }
      if (dirty) await this.store.writeScheduleState(this.state);
    } catch (error) {
      await this.ledgerScheduleError(stage, error);
    }
  }

  private ensureStateForTrigger(trigger: Trigger, timing: ScheduleTiming, now: Date): boolean {
    const entry = this.entry(trigger.id);
    const key = timingHash(timing);
    if (entry.timingHash && entry.timingHash !== key) {
      this.setEntry(trigger.id, { timingHash: key, nextFireAt: initialNextFire(timing, now).toISOString() });
      return true;
    }
    const updated: ScheduleEntry = { ...entry };
    let dirty = false;
    if (updated.timingHash !== key) {
      updated.timingHash = key;
      dirty = true;
    }
    if (timing.type === "once" && updated.completedOnce) {
      if (dirty) this.setEntry(trigger.id, updated);
      return dirty;
    }
    if (!updated.nextFireAt) {
      updated.nextFireAt = initialNextFire(timing, now).toISOString();
      dirty = true;
    }
    if (dirty) this.setEntry(trigger.id, updated);
    return dirty;
  }

  private async handleMissedFire(trigger: Trigger, timing: ScheduleTiming, scheduledAt: Date, now: Date): Promise<void> {
    const policy = missedFirePolicy(timing);
    if (timing.type === "once") {
      if (policy === "skip") {
        await this.completeOnce(trigger, scheduledAt);
        return;
      }
      await this.reserveAndFire(trigger, timing, scheduledAt, undefined);
      return;
    }
    if (policy === "skip") {
      this.setEntry(trigger.id, {
        ...this.entry(trigger.id),
        nextFireAt: nextFireAfter(timing, now, { previousFireAt: lastFireDate(this.entry(trigger.id)) }).toISOString(),
        timingHash: timingHash(timing),
      });
      await this.store.writeScheduleState(this.state);
      return;
    }
    if (policy === "fire-once") {
      await this.reserveAndFire(trigger, timing, scheduledAt, nextFireAfter(timing, now, { previousFireAt: scheduledAt }));
      return;
    }
    let cursor = scheduledAt;
    let count = 0;
    while (cursor.getTime() <= now.getTime() && count < 100) {
      const next = this.nextAfterScheduled(timing, cursor);
      await this.reserveAndFire(trigger, timing, cursor, next);
      cursor = next;
      count += 1;
    }
    if (cursor.getTime() <= now.getTime()) {
      this.setEntry(trigger.id, {
        ...this.entry(trigger.id),
        nextFireAt: nextFireAfter(timing, now, { previousFireAt: cursor }).toISOString(),
        timingHash: timingHash(timing),
      });
      await this.store.writeScheduleState(this.state);
    }
  }

  private nextAfterScheduled(timing: ScheduleTiming, scheduledAt: Date): Date {
    return nextFireAfter(timing, scheduledAt, { previousFireAt: scheduledAt });
  }

  private async reserveAndFire(trigger: Trigger, timing: ScheduleTiming, scheduledAt: Date, nextFireAt: Date | undefined): Promise<void> {
    if (timing.type === "once") {
      await this.completeOnce(trigger, scheduledAt, false);
      await this.fire(trigger, scheduledAt);
      trigger.enabled = false;
      return;
    } else {
      this.setEntry(trigger.id, {
        ...this.entry(trigger.id),
        lastFireAt: scheduledAt.toISOString(),
        nextFireAt: nextFireAt?.toISOString(),
        timingHash: timingHash(timing),
      });
      await this.store.writeScheduleState(this.state);
    }
    await this.fire(trigger, scheduledAt);
  }

  private async completeOnce(trigger: Trigger, scheduledAt: Date, disableRuntime = true): Promise<void> {
    this.setEntry(trigger.id, {
      ...this.entry(trigger.id),
      completedOnce: true,
      lastFireAt: scheduledAt.toISOString(),
      nextFireAt: undefined,
      timingHash: trigger.source.kind === "schedule" ? timingHash(trigger.source.timing) : undefined,
    });
    await this.store.writeScheduleState(this.state);
    await this.store.setTriggerEnabled(trigger.id, false);
    if (disableRuntime) trigger.enabled = false;
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

  private entry(triggerId: string): ScheduleEntry {
    return (this.state[triggerId] ?? {}) as ScheduleEntry;
  }

  private setEntry(triggerId: string, entry: ScheduleEntry): void {
    this.state[triggerId] = entry;
  }

  private isDuplicateCronWallTime(timing: ScheduleTiming, scheduledAt: Date, lastFireAt?: string): boolean {
    if (timing.type !== "cron" || !lastFireAt) return false;
    const previous = parseIsoDate(lastFireAt, "lastFireAt");
    const timezone = timing.timezone ?? "UTC";
    return localMinuteKey(zonedParts(scheduledAt, timezone)) === localMinuteKey(zonedParts(previous, timezone));
  }

  private async ledgerMissed(trigger: Trigger, timing: ScheduleTiming, scheduledAt: string): Promise<void> {
    await this.store.appendLedger({ event: "pollinate.schedule.missed", trigger_id: trigger.id, policy: missedFirePolicy(timing), scheduled_at: scheduledAt });
  }

  private async ledgerScheduleError(stage: string, error: unknown, triggerId?: string): Promise<void> {
    try {
      await this.store.appendLedger({
        event: "pollinate.schedule.errored",
        stage,
        ...(triggerId ? { trigger_id: triggerId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // If the ledger itself is unavailable, keep the daemon alive.
    }
  }
}

function initialNextFire(timing: ScheduleTiming, now: Date): Date {
  if (timing.type === "once") return parseIsoDate(timing.at, "once schedule");
  return nextFireAfter(timing, now);
}

export function nextFireAfter(timing: ScheduleTiming, after: Date, options: NextFireOptions = {}): Date {
  if (timing.type === "every") {
    return new Date(after.getTime() + parseDuration(timing.interval));
  }
  if (timing.type === "once") {
    const at = parseIsoDate(timing.at, "once schedule");
    return at.getTime() <= after.getTime() ? NEVER_FIRE : at;
  }
  return nextCronFireAfter(timing.expression, after, timing.timezone ?? "UTC", options);
}

export function nextCronFireAfter(expression: string, after: Date, timezone = "UTC", options: NextFireOptions = {}): Date {
  const fields = parseCronExpression(expression);
  const cursor = new Date(after.getTime() + 60_000);
  cursor.setUTCSeconds(0, 0);
  const deadline = new Date(after.getTime() + 366 * 24 * 60 * 60_000 * 5);
  const previousFireLocal = options.previousFireAt ? localMinuteKey(zonedParts(options.previousFireAt, timezone)) : undefined;
  let previousParts = zonedParts(new Date(cursor.getTime() - 60_000), timezone);
  while (cursor <= deadline) {
    const parts = zonedParts(cursor, timezone);
    const skippedLocal = skippedForwardMatch(fields, previousParts, parts, previousFireLocal);
    if (skippedLocal) return new Date(cursor);
    if (cronMatches(fields, parts)) {
      const key = localMinuteKey(parts);
      if (key !== previousFireLocal) return new Date(cursor);
    }
    const stepMs = cronStepMs(fields, parts);
    previousParts = parts;
    cursor.setTime(cursor.getTime() + stepMs);
    cursor.setUTCSeconds(0, 0);
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
  year: number;
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
    dayOfWeek: parseCronField(dow, 0, 6, { allowSevenAsSunday: true }),
    domAny: dom === "*",
    dowAny: dow === "*",
  };
}

function parseCronField(field: string, min: number, max: number, options: { allowSevenAsSunday?: boolean } = {}): Set<number> {
  const out = new Set<number>();
  const fieldMax = options.allowSevenAsSunday ? Math.max(max, 7) : max;
  for (const token of field.split(",")) {
    const [rangePart, stepPart] = token.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${token}`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = fieldMax;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = Number(rawStart);
      end = Number(rawEnd);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > fieldMax || start > end) {
      throw new Error(`Invalid cron field "${field}"`);
    }
    for (let value = start; value <= end; value += step) out.add(options.allowSevenAsSunday && value === 7 ? 0 : value);
  }
  return out;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timezone: string): ZonedParts {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return {
    year: Number(parts.year),
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekday,
  };
}

function cronMatches(fields: CronFields, parts: ZonedParts): boolean {
  return fields.minute.has(parts.minute) && fields.hour.has(parts.hour) && fields.month.has(parts.month) && cronDayMatches(fields, parts);
}

function cronDayMatches(fields: CronFields, parts: ZonedParts): boolean {
  const domMatches = fields.dayOfMonth.has(parts.dayOfMonth);
  const dowMatches = fields.dayOfWeek.has(parts.dayOfWeek);
  return fields.domAny && fields.dowAny ? true : fields.domAny ? dowMatches : fields.dowAny ? domMatches : domMatches || dowMatches;
}

export function missedFirePolicy(timing: ScheduleTiming): MissedFirePolicy {
  return timing.missedFirePolicy ?? "skip";
}

function isMissedInTick(timing: ScheduleTiming, scheduledAt: Date, now: Date): boolean {
  if (timing.type !== "every") return false;
  return now.getTime() - scheduledAt.getTime() >= parseDuration(timing.interval);
}

function timingHash(timing: ScheduleTiming): string {
  if (timing.type === "cron") return `cron:${timing.expression}:${timing.timezone ?? "UTC"}:${timing.missedFirePolicy ?? ""}`;
  if (timing.type === "every") return `every:${timing.interval}:${timing.missedFirePolicy ?? ""}`;
  return `once:${timing.at}:${timing.missedFirePolicy ?? ""}`;
}

function lastFireDate(entry: ScheduleEntry): Date | undefined {
  return entry.lastFireAt ? parseIsoDate(entry.lastFireAt, "lastFireAt") : undefined;
}

function cronStepMs(fields: CronFields, parts: ZonedParts): number {
  if (!fields.month.has(parts.month) || !cronDayMatches(fields, parts)) return parts.hour >= 23 ? 60_000 : 60 * 60_000;
  if (!fields.hour.has(parts.hour)) {
    const nextHourDistance = minutesUntilNextAllowedHour(fields.hour, parts.hour);
    return nextHourDistance <= 60 ? 60_000 : 60 * 60_000;
  }
  if (!fields.minute.has(parts.minute)) {
    const nextMinute = nextAllowedMinuteInHour(fields.minute, parts.minute);
    return nextMinute === undefined ? 60_000 : Math.max(60_000, (nextMinute - parts.minute) * 60_000);
  }
  return 60_000;
}

function minutesUntilNextAllowedHour(hours: Set<number>, current: number): number {
  for (let offset = 1; offset <= 24; offset += 1) {
    if (hours.has((current + offset) % 24)) return offset * 60;
  }
  return 60;
}

function nextAllowedMinuteInHour(minutes: Set<number>, current: number): number | undefined {
  for (let minute = current + 1; minute <= 59; minute += 1) {
    if (minutes.has(minute)) return minute;
  }
  return undefined;
}

function skippedForwardMatch(fields: CronFields, from: ZonedParts, to: ZonedParts, previousFireLocal?: string): string | undefined {
  const fromWall = wallMinuteMs(from);
  const toWall = wallMinuteMs(to);
  if (toWall <= fromWall + 60_000) return undefined;
  for (let wall = fromWall + 60_000; wall < toWall; wall += 60_000) {
    const parts = partsFromWallMinute(wall);
    if (!cronMatches(fields, parts)) continue;
    const key = localMinuteKey(parts);
    if (key !== previousFireLocal) return key;
  }
  return undefined;
}

function wallMinuteMs(parts: ZonedParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth, parts.hour, parts.minute);
}

function partsFromWallMinute(wallMinute: number): ZonedParts {
  const date = new Date(wallMinute);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    dayOfMonth: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    dayOfWeek: date.getUTCDay(),
  };
}

function localMinuteKey(parts: ZonedParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.dayOfMonth)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
