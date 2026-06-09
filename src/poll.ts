import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Activation, CursorState, JsonValue, PollSpec, Trigger } from "./types.js";
import { DeliveryManager } from "./delivery.js";
import { PollinateStore } from "./store.js";
import { execShell } from "./process.js";
import { selectJsonPathArray } from "./jsonpath.js";
import { nowIso, parseDuration, stableStringify } from "./time.js";

export class PollEngine {
  private cursors: CursorState = {};
  private timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(
    private readonly store: PollinateStore,
    private readonly delivery: DeliveryManager,
    private triggers: Trigger[],
  ) {}

  async start(): Promise<void> {
    this.cursors = await this.store.readCursorState();
    this.running = true;
    this.reconcileTimers();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.store.writeCursorState(this.cursors);
  }

  updateTriggers(triggers: Trigger[]): void {
    this.triggers = triggers;
    this.reconcileTimers();
  }

  async pollNow(trigger: Trigger): Promise<number> {
    if (trigger.source.kind !== "poll") throw new Error(`Trigger ${trigger.id} is not a poll trigger`);
    const spec = trigger.source.poll;
    const fetched = await fetchPoll(spec, trigger.cwd);
    const delta = detectDelta(spec, trigger.id, fetched, this.cursors);
    if (delta.items.length > 0) {
      if (spec.emit === "per-item") {
        for (const item of delta.items) {
          await this.dispatch(trigger, item);
        }
      } else {
        await this.dispatch(trigger, delta.items as JsonValue);
      }
      await this.store.appendLedger({ event: "pollinate.poll.detected", trigger_id: trigger.id, item_count: delta.items.length, at: nowIso() });
    }
    this.cursors = delta.cursors;
    await this.store.writeCursorState(this.cursors);
    return delta.items.length;
  }

  private schedule(trigger: Trigger, delayMs: number): void {
    if (!this.running) return;
    const existing = this.timers.get(trigger.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.timers.delete(trigger.id);
      try {
        const latest = this.pollTriggers().find((item) => item.id === trigger.id);
        if (latest) await this.pollNow(latest);
      } catch (error) {
        await this.store.appendLedger({
          event: "pollinate.poll.errored",
          trigger_id: trigger.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        const latest = this.pollTriggers().find((item) => item.id === trigger.id);
        if (latest && latest.source.kind === "poll") this.schedule(latest, parseDuration(latest.source.poll.interval));
      }
    }, delayMs);
    this.timers.set(trigger.id, timer);
  }

  private reconcileTimers(): void {
    if (!this.running) return;
    const active = new Map(this.pollTriggers().map((trigger) => [trigger.id, trigger]));
    for (const [triggerId, timer] of this.timers.entries()) {
      if (!active.has(triggerId)) {
        clearTimeout(timer);
        this.timers.delete(triggerId);
      }
    }
    for (const trigger of active.values()) {
      if (!this.timers.has(trigger.id)) this.schedule(trigger, 0);
    }
  }

  private async dispatch(trigger: Trigger, payload: JsonValue): Promise<void> {
    const activation: Activation = { triggerId: trigger.id, source: "poll", payload, receivedAt: nowIso() };
    await this.delivery.handle(trigger, activation);
  }

  private pollTriggers(): Trigger[] {
    return this.triggers.filter((trigger) => trigger.enabled && trigger.source.kind === "poll");
  }
}

export async function fetchPoll(spec: PollSpec, cwd?: string): Promise<string> {
  if (spec.fetch.kind === "file") return readFile(spec.fetch.path, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return "";
    throw error;
  });
  if (spec.fetch.kind === "command") {
    const result = await execShell(spec.fetch.command, { cwd: spec.fetch.cwd ?? cwd });
    if (result.exitCode !== 0) throw new Error(`poll command exited ${result.exitCode}: ${result.stderr.trim()}`);
    return result.stdout;
  }
  const response = await fetch(spec.fetch.url, { method: spec.fetch.method ?? "GET", headers: spec.fetch.headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`poll HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

export function detectDelta(
  spec: PollSpec,
  triggerId: string,
  fetched: string,
  cursors: CursorState,
): { items: JsonValue[]; cursors: CursorState } {
  const next = { ...cursors };
  const key = triggerId;
  if (spec.cursor.strategy === "append-offset") {
    const previous = typeof cursors[key] === "number" ? cursors[key] : 0;
    const current = fetched.length;
    next[key] = current;
    if (current <= previous) return { items: [], cursors: next };
    const delta = fetched.slice(previous);
    return { items: parseLines(delta), cursors: next };
  }
  if (spec.cursor.strategy === "hash") {
    const previous = new Set(Array.isArray(cursors[key]) ? (cursors[key] as JsonValue[]).map(String) : []);
    const items = parsePollItems(fetched);
    const newItems: JsonValue[] = [];
    const hashes: string[] = [];
    for (const item of items) {
      const hash = hashValue(item);
      hashes.push(hash);
      if (!previous.has(hash)) newItems.push(item);
    }
    next[key] = hashes;
    return { items: newItems, cursors: next };
  }
  const json = JSON.parse(fetched || "null");
  const selected = selectJsonPathArray(spec.cursor.jsonpath, json);
  const previous = new Set(Array.isArray(cursors[key]) ? (cursors[key] as JsonValue[]).map(String) : []);
  const ids = selected.map((item) => String(item));
  next[key] = ids;
  return {
    items: selected.filter((item) => !previous.has(String(item))).map(toJsonValue),
    cursors: next,
  };
}

function parsePollItems(text: string): JsonValue[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.map(toJsonValue);
    return [toJsonValue(parsed)];
  } catch {
    return parseLines(text);
  }
}

function parseLines(text: string): JsonValue[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return toJsonValue(JSON.parse(line));
      } catch {
        return line;
      }
    });
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    typeof value === "object"
  ) {
    return value as JsonValue;
  }
  return String(value);
}

function hashValue(value: JsonValue): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
