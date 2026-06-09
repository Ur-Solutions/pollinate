import type { Activation, DeliveryState, Job, JsonValue, Trigger } from "./types.js";
import { ActionExecutor } from "./actions.js";
import { PollinateStore } from "./store.js";
import { nowIso, parseDuration } from "./time.js";

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
    this.persisted = await this.store.readDeliveryState();
    if (!this.restored) {
      this.restored = true;
      await this.restore();
    }
  }

  async handle(trigger: Trigger, activation: Activation): Promise<Job | null> {
    if (!trigger.enabled) return null;
    if (!matchesFilter(trigger, activation.payload)) {
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
        const delay = Math.max(0, new Date(state.timerDueAt).getTime() - now);
        runtime.timer = setTimeout(() => {
          void this.flushPending(trigger);
        }, delay);
      }
      void this.drain(trigger);
    }
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
    state.pendingBatch = [...(state.pendingBatch ?? []), activation];
    state.timerDueAt = new Date(Date.now() + parseDuration(mode.quietPeriod)).toISOString();
    state.timerKind = "debounced";
    this.persisted[trigger.id] = state;
    this.setTimer(trigger, parseDuration(mode.quietPeriod), "debounced");
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
    void this.drain(trigger);
    return job;
  }

  private async drain(trigger: Trigger): Promise<void> {
    const runtime = this.runtimeFor(trigger.id);
    while (runtime.running < trigger.delivery.maxConcurrent && runtime.queue.length > 0) {
      const next = runtime.queue.shift();
      if (!next) return;
      await this.saveQueue(trigger.id);
      const latest = await this.store.getJob(next.job.id);
      if (latest?.status === "cancelled") continue;
      runtime.running += 1;
      this.executor
        .executeJob(next.job, next.trigger, next.activation, next.batch)
        .catch((error) =>
          this.store.appendLedger({
            event: "pollinate.job.errored",
            job_id: next.job.id,
            trigger_id: next.trigger.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          runtime.running = Math.max(0, runtime.running - 1);
          void this.drain(trigger);
        });
    }
  }

  private setTimer(trigger: Trigger, delayMs: number, kind: "throttled" | "batched" | "debounced"): void {
    const runtime = this.runtimeFor(trigger.id);
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => {
      void this.flushPending(trigger);
    }, delayMs);
    const state = this.persistedFor(trigger.id);
    state.timerKind = kind;
    state.timerDueAt = new Date(Date.now() + delayMs).toISOString();
    this.persisted[trigger.id] = state;
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

function matchesFilter(trigger: Trigger, payload: JsonValue): boolean {
  if (!trigger.filter) return true;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const object = payload as Record<string, JsonValue>;
  return Object.entries(trigger.filter).every(([key, expected]) => {
    if (expected === true) return Object.prototype.hasOwnProperty.call(object, key);
    return JSON.stringify(object[key]) === JSON.stringify(expected);
  });
}
