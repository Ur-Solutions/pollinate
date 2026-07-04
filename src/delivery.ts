import type { Activation, DeliveryState, Job, JsonValue, Trigger } from "./types.js";
import { ActionExecutor } from "./actions.js";
import { matchesFilter } from "./filter.js";
import { PollinateStore } from "./store.js";
import { nowIso, parseDuration } from "./time.js";
import { appendTextLine, daemonLogPath } from "./fsx.js";

const DEBOUNCE_MAX_WAIT_MULTIPLIER = 6;

type RuntimeState = {
  running: number;
  queue: Array<{ job: Job; trigger: Trigger; activation: Activation; batch: JsonValue[] }>;
  timer?: NodeJS.Timeout;
};

export class DeliveryManager {
  private persisted: DeliveryState = {};
  private runtime = new Map<string, RuntimeState>();
  private triggers = new Map<string, Trigger>();
  private restored = false;

  constructor(
    private readonly store: PollinateStore,
    private readonly executor: ActionExecutor,
  ) {}

  async init(triggers: Trigger[]): Promise<void> {
    this.triggers = new Map(triggers.map((trigger) => [trigger.id, trigger]));
    if (!this.restored) this.persisted = await this.store.readDeliveryState();
    if (this.pruneOrphanedState()) await this.persist();
    if (!this.restored) {
      this.restored = true;
      await this.restore();
    }
  }

  async handle(trigger: Trigger, activation: Activation): Promise<Job | null> {
    if (!trigger.enabled) return null;
    if (!matchesFilter(trigger.filter, activation.payload)) {
      await this.store.appendLedger({ event: "pollinate.delivery.filtered", trigger_id: trigger.id });
      return null;
    }
    this.triggers.set(trigger.id, trigger);
    const mode = trigger.delivery.mode;
    if (mode.strategy === "immediate") return this.enqueue(trigger, activation, [activation.payload]);
    if (mode.strategy === "throttled") return this.handleThrottled(trigger, activation);
    if (mode.strategy === "batched") return this.handleBatched(trigger, activation);
    if (mode.strategy === "debounced") return this.handleDebounced(trigger, activation);
    const neverMode: never = mode;
    throw new Error(`Unsupported delivery mode: ${JSON.stringify(neverMode)}`);
  }

  async shutdown(): Promise<void> {
    for (const state of this.runtime.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    await this.persist();
  }

  private async restore(): Promise<void> {
    const now = Date.now();
    for (const [triggerId, state] of Object.entries(this.persisted)) {
      const trigger = this.triggers.get(triggerId);
      if (!trigger) continue;
      const runtime = this.runtimeFor(trigger.id);
      for (const queued of state.queue ?? []) {
        runtime.queue.push({ ...queued, trigger });
      }
      if (state.pendingBatch?.length && state.timerDueAt && state.timerKind) {
        const delay = this.pendingTimerDelayMs(trigger, state, now);
        runtime.timer = setTimeout(() => {
          this.runFlushPending(trigger);
        }, delay);
      }
      this.runDrain(trigger);
    }
  }

  private pruneOrphanedState(): boolean {
    let changed = false;
    for (const triggerId of Object.keys(this.persisted)) {
      if (this.triggers.has(triggerId)) continue;
      delete this.persisted[triggerId];
      changed = true;
    }
    for (const [triggerId, state] of this.runtime.entries()) {
      if (this.triggers.has(triggerId)) continue;
      if (state.timer) clearTimeout(state.timer);
      this.runtime.delete(triggerId);
      changed = true;
    }
    return changed;
  }

  private async handleThrottled(trigger: Trigger, activation: Activation): Promise<Job | null> {
    const mode = trigger.delivery.mode;
    if (mode.strategy !== "throttled") return null;
    const state = this.persistedFor(trigger.id);
    const now = Date.now();
    const throttleUntil = state.throttleUntil ? new Date(state.throttleUntil).getTime() : 0;
    if (now >= throttleUntil) {
      const batch = mode.collect && state.pendingBatch?.length ? [...state.pendingBatch.map((item) => item.payload), activation.payload] : [activation.payload];
      this.persisted[trigger.id] = { ...state, throttleUntil: new Date(now + parseDuration(mode.interval)).toISOString(), pendingBatch: undefined, timerDueAt: undefined, timerKind: undefined };
      this.setTimer(trigger, parseDuration(mode.interval), "throttled");
      await this.persist();
      return this.enqueue(trigger, activation, batch);
    }
    if (mode.collect) {
      state.pendingBatch = [...(state.pendingBatch ?? []), activation];
      state.timerDueAt = new Date(throttleUntil).toISOString();
      state.timerKind = "throttled";
      this.persisted[trigger.id] = state;
      this.setTimer(trigger, Math.max(0, throttleUntil - now), "throttled");
      await this.persist();
      return null;
    }
    await this.store.appendLedger({ event: "pollinate.delivery.throttled", trigger_id: trigger.id, until: state.throttleUntil });
    return null;
  }

  private async handleBatched(trigger: Trigger, activation: Activation): Promise<Job | null> {
    const mode = trigger.delivery.mode;
    if (mode.strategy !== "batched") return null;
    const state = this.persistedFor(trigger.id);
    state.pendingBatch = [...(state.pendingBatch ?? []), activation];
    if (!state.timerDueAt) state.timerDueAt = new Date(Date.now() + parseDuration(mode.window)).toISOString();
    state.timerKind = "batched";
    this.persisted[trigger.id] = state;
    if (state.pendingBatch.length >= mode.maxBatch) {
      return this.flushPending(trigger);
    }
    this.setTimer(trigger, Math.max(0, new Date(state.timerDueAt).getTime() - Date.now()), "batched");
    await this.persist();
    return null;
  }

  private async handleDebounced(trigger: Trigger, activation: Activation): Promise<Job | null> {
    const mode = trigger.delivery.mode;
    if (mode.strategy !== "debounced") return null;
    const state = this.persistedFor(trigger.id);
    const now = Date.now();
    const quietMs = parseDuration(mode.quietPeriod);
    state.pendingBatch = [...(state.pendingBatch ?? []), activation];
    const maxDueAt = this.debounceMaxDueAt(state.pendingBatch, quietMs, now);
    const dueAt = Math.min(now + quietMs, maxDueAt);
    state.timerDueAt = new Date(dueAt).toISOString();
    state.timerKind = "debounced";
    this.persisted[trigger.id] = state;
    if (dueAt <= now) return this.flushPending(trigger);
    this.setTimer(trigger, dueAt - now, "debounced");
    await this.persist();
    return null;
  }

  private async flushPending(trigger: Trigger): Promise<Job | null> {
    const state = this.persistedFor(trigger.id);
    const pending = state.pendingBatch ?? [];
    if (pending.length === 0) return null;
    const activation = pending[pending.length - 1];
    const batch = pending.map((item) => item.payload);
    this.persisted[trigger.id] = {
      ...state,
      pendingBatch: undefined,
      timerDueAt: undefined,
      timerKind: undefined,
      throttleUntil:
        trigger.delivery.mode.strategy === "throttled"
          ? new Date(Date.now() + parseDuration(trigger.delivery.mode.interval)).toISOString()
          : state.throttleUntil,
    };
    const runtime = this.runtimeFor(trigger.id);
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = undefined;
    }
    await this.persist();
    return this.enqueue(trigger, activation, batch);
  }

  private async enqueue(trigger: Trigger, activation: Activation, batch: JsonValue[]): Promise<Job> {
    const job = await this.executor.createQueuedJob(trigger, activation, batch);
    await this.store.saveJob(job);
    await this.store.appendLedger({
      event: "pollinate.job.queued",
      job_id: job.id,
      trigger_id: trigger.id,
      queue_position: this.runtimeFor(trigger.id).queue.length,
      at: nowIso(),
    });
    const runtime = this.runtimeFor(trigger.id);
    runtime.queue.push({ job, trigger, activation, batch });
    await this.saveQueue(trigger.id);
    this.runDrain(trigger);
    return job;
  }

  private async drain(trigger: Trigger): Promise<void> {
    const runtime = this.runtimeFor(trigger.id);
    while (runtime.running < trigger.delivery.maxConcurrent && runtime.queue.length > 0) {
      const next = runtime.queue.shift();
      if (!next) return;
      runtime.running += 1;
      let handedOff = false;
      try {
        await this.saveQueue(trigger.id);
        const latest = await this.store.getJob(next.job.id);
        if (latest?.status === "cancelled") continue;
        handedOff = true;
        this.executor
          .executeJob(next.job, next.trigger, next.activation, next.batch)
          .catch((error) => {
            void this.store.appendLedger({
              event: "pollinate.job.errored",
              job_id: next.job.id,
              trigger_id: next.trigger.id,
              error: error instanceof Error ? error.message : String(error),
            }).catch((ledgerError) => this.logAsyncError("job error ledger", next.trigger, ledgerError));
          })
          .finally(() => {
            runtime.running = Math.max(0, runtime.running - 1);
            this.runDrain(trigger);
          });
      } catch (error) {
        runtime.queue.unshift(next);
        await this.saveQueue(trigger.id).catch(() => undefined);
        throw error;
      } finally {
        if (!handedOff) runtime.running = Math.max(0, runtime.running - 1);
      }
    }
  }

  private setTimer(trigger: Trigger, delayMs: number, kind: "throttled" | "batched" | "debounced"): void {
    const runtime = this.runtimeFor(trigger.id);
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => {
      this.runFlushPending(trigger);
    }, delayMs);
    const state = this.persistedFor(trigger.id);
    state.timerKind = kind;
    state.timerDueAt = new Date(Date.now() + delayMs).toISOString();
    this.persisted[trigger.id] = state;
  }

  private pendingTimerDelayMs(trigger: Trigger, state: NonNullable<DeliveryState[string]>, now: number): number {
    let dueAt = state.timerDueAt ? this.timeMsOr(state.timerDueAt, now) : now;
    if (state.timerKind === "debounced" && trigger.delivery.mode.strategy === "debounced" && state.pendingBatch?.length) {
      dueAt = Math.min(dueAt, this.debounceMaxDueAt(state.pendingBatch, parseDuration(trigger.delivery.mode.quietPeriod), now));
    }
    return Math.max(0, dueAt - now);
  }

  private debounceMaxDueAt(pending: Activation[], quietMs: number, fallback: number): number {
    const first = pending[0];
    const firstSeenAt = first ? this.timeMsOr(first.receivedAt, fallback) : fallback;
    return firstSeenAt + quietMs * DEBOUNCE_MAX_WAIT_MULTIPLIER;
  }

  private timeMsOr(value: string, fallback: number): number {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  private runDrain(trigger: Trigger): void {
    void this.drain(trigger).catch((error) => this.logAsyncError("drain", trigger, error));
  }

  private runFlushPending(trigger: Trigger): void {
    void this.flushPending(trigger).catch((error) => this.logAsyncError("flushPending", trigger, error));
  }

  private async logAsyncError(operation: string, trigger: Trigger, error: unknown): Promise<void> {
    try {
      const message = error instanceof Error ? error.message : String(error);
      await appendTextLine(daemonLogPath(this.store.root), `${nowIso()} delivery ${operation} failed for ${trigger.id}: ${message}`);
    } catch {
      // Delivery-side error logging must not become another unhandled rejection.
    }
  }

  private runtimeFor(triggerId: string): RuntimeState {
    let state = this.runtime.get(triggerId);
    if (!state) {
      state = { running: 0, queue: [] };
      this.runtime.set(triggerId, state);
    }
    return state;
  }

  private persistedFor(triggerId: string): NonNullable<DeliveryState[string]> {
    const state = this.persisted[triggerId] ?? {};
    this.persisted[triggerId] = state;
    return state;
  }

  private async saveQueue(triggerId: string): Promise<void> {
    const runtime = this.runtimeFor(triggerId);
    const state = this.persistedFor(triggerId);
    state.queue = runtime.queue.map(({ job, activation, batch }) => ({ job, activation, batch }));
    this.persisted[triggerId] = state;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.writeDeliveryState(this.persisted);
  }
}
