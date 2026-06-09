import { basename, extname } from "node:path";
import { parse, stringify } from "smol-toml";
import type {
  Action,
  ContextSource,
  ContextResolver,
  DaemonConfig,
  Delivery,
  DeliveryMode,
  Filter,
  JsonValue,
  PollCursor,
  PollFetch,
  PollSpec,
  ScheduleTiming,
  Source,
  Trigger,
  WebhookSpec,
} from "./types.js";
import { parseDuration } from "./time.js";

type AnyRecord = Record<string, unknown>;

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  webhook: { bind: "127.0.0.1", port: 3978 },
  defaults: { contextTimeout: "5s", commandTimeout: "10m", tickMs: 1_000, triggerReloadMs: 1_000 },
};

export function parseTriggerToml(text: string, fallbackId?: string): Trigger {
  const doc = parse(text) as AnyRecord;
  const rawTrigger = asRecord(doc.trigger, "trigger");
  return normalizeTrigger(rawTrigger, fallbackId);
}

export function triggerToToml(trigger: Trigger): string {
  return stringify({ trigger: stripRuntimeDates(trigger) }) as string;
}

export function parseDaemonConfigToml(text: string | null): DaemonConfig {
  if (!text || text.trim() === "") return DEFAULT_DAEMON_CONFIG;
  const doc = parse(text) as AnyRecord;
  const webhook = asOptionalRecord(doc.webhook) ?? {};
  const defaults = asOptionalRecord(doc.defaults) ?? {};
  return {
    webhook: {
      bind: stringOr(webhook.bind, DEFAULT_DAEMON_CONFIG.webhook.bind),
      port: numberOr(webhook.port, DEFAULT_DAEMON_CONFIG.webhook.port),
    },
    defaults: {
      contextTimeout: stringOr(defaults.contextTimeout ?? defaults.context_timeout, DEFAULT_DAEMON_CONFIG.defaults.contextTimeout),
      commandTimeout: stringOr(defaults.commandTimeout ?? defaults.command_timeout, DEFAULT_DAEMON_CONFIG.defaults.commandTimeout),
      tickMs: numberOr(defaults.tickMs ?? defaults.tick_ms, DEFAULT_DAEMON_CONFIG.defaults.tickMs),
      triggerReloadMs: numberOr(defaults.triggerReloadMs ?? defaults.trigger_reload_ms, DEFAULT_DAEMON_CONFIG.defaults.triggerReloadMs),
    },
  };
}

export function idFromPath(path: string): string {
  return basename(path, extname(path));
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "trigger";
}

function normalizeTrigger(raw: AnyRecord, fallbackId?: string): Trigger {
  const now = new Date().toISOString();
  const name = stringOr(raw.name, fallbackId ?? "trigger");
  const id = stringOr(raw.id, fallbackId ?? slugify(name));
  const source = normalizeSource(asRecord(raw.source, "trigger.source"));
  const delivery = normalizeDelivery(asRecord(raw.delivery, "trigger.delivery"));
  return {
    id,
    name,
    description: optionalString(raw.description),
    cwd: optionalString(raw.cwd),
    tags: stringArray(raw.tags),
    enabled: booleanOr(raw.enabled, true),
    source,
    filter: normalizeFilter(asOptionalRecord(raw.filter)),
    delivery,
    context: normalizeContext(asOptionalRecord(raw.context)),
    action: normalizeAction(asRecord(raw.action, "trigger.action")),
    createdAt: stringOr(raw.createdAt ?? raw.created_at, now),
    updatedAt: stringOr(raw.updatedAt ?? raw.updated_at, now),
  };
}

function normalizeSource(raw: AnyRecord): Source {
  const kind = stringOr(raw.kind, "");
  if (kind === "schedule") {
    return { kind, timing: normalizeTiming(asRecord(raw.timing, "trigger.source.timing")) };
  }
  if (kind === "poll") {
    return { kind, poll: normalizePoll(asRecord(raw.poll, "trigger.source.poll")) };
  }
  if (kind === "webhook") {
    return { kind, webhook: normalizeWebhook(asRecord(raw.webhook, "trigger.source.webhook")) };
  }
  if (kind === "manual") return { kind };
  throw new Error(`Unsupported source kind: ${kind || "(missing)"}`);
}

function normalizeTiming(raw: AnyRecord): ScheduleTiming {
  const type = stringOr(raw.type, "");
  const missedFirePolicy = normalizeMissedFirePolicy(raw.missedFirePolicy ?? raw.missed_fire_policy);
  if (type === "cron") {
    const expression = requiredString(raw.expression, "trigger.source.timing.expression");
    return {
      type,
      expression,
      timezone: stringOr(raw.timezone, "UTC"),
      ...(missedFirePolicy ? { missedFirePolicy } : {}),
    };
  }
  if (type === "every") {
    const interval = requiredString(raw.interval, "trigger.source.timing.interval");
    parseDuration(interval);
    return { type, interval, ...(missedFirePolicy ? { missedFirePolicy } : {}) };
  }
  if (type === "once") {
    const at = requiredString(raw.at, "trigger.source.timing.at");
    if (Number.isNaN(new Date(at).getTime())) throw new Error(`Invalid once schedule time: ${at}`);
    return { type, at, ...(missedFirePolicy ? { missedFirePolicy } : {}) };
  }
  throw new Error(`Unsupported schedule timing type: ${type || "(missing)"}`);
}

function normalizePoll(raw: AnyRecord): PollSpec {
  const interval = requiredString(raw.interval, "trigger.source.poll.interval");
  parseDuration(interval);
  const emit = stringOr(raw.emit, "per-item");
  if (emit !== "per-item" && emit !== "per-poll") throw new Error(`Unsupported poll emit mode: ${emit}`);
  return {
    interval,
    emit,
    fetch: normalizePollFetch(asRecord(raw.fetch, "trigger.source.poll.fetch")),
    cursor: normalizePollCursor(asRecord(raw.cursor, "trigger.source.poll.cursor")),
  };
}

function normalizePollFetch(raw: AnyRecord): PollFetch {
  const kind = stringOr(raw.kind, "");
  if (kind === "command") return { kind, command: requiredString(raw.command, "fetch.command"), cwd: optionalString(raw.cwd) };
  if (kind === "http") {
    return {
      kind,
      method: stringOr(raw.method, "GET"),
      url: requiredString(raw.url, "fetch.url"),
      headers: stringRecord(asOptionalRecord(raw.headers)),
    };
  }
  if (kind === "file") return { kind, path: requiredString(raw.path, "fetch.path") };
  throw new Error(`Unsupported poll fetch kind: ${kind || "(missing)"}`);
}

function normalizePollCursor(raw: AnyRecord): PollCursor {
  const strategy = stringOr(raw.strategy, "");
  if (strategy === "append-offset") return { strategy };
  if (strategy === "hash") return { strategy };
  if (strategy === "jsonpath") return { strategy, jsonpath: requiredString(raw.jsonpath, "cursor.jsonpath") };
  throw new Error(`Unsupported poll cursor strategy: ${strategy || "(missing)"}`);
}

function normalizeWebhook(raw: AnyRecord): WebhookSpec {
  return {
    path: requiredString(raw.path, "trigger.source.webhook.path").replace(/^\/+/, ""),
    secret: optionalString(raw.secret),
    transform: stringRecord(asOptionalRecord(raw.transform)),
  };
}

function normalizeDelivery(raw: AnyRecord): Delivery {
  const maxConcurrent = Math.max(1, numberOr(raw.maxConcurrent ?? raw.max_concurrent, 1));
  return {
    mode: normalizeDeliveryMode(raw),
    maxConcurrent,
  };
}

function normalizeDeliveryMode(raw: AnyRecord): DeliveryMode {
  const modeRaw = asOptionalRecord(raw.mode);
  const strategy = stringOr(modeRaw?.strategy ?? raw.strategy ?? raw.mode, "");
  if (strategy === "immediate") return { strategy };
  if (strategy === "throttled") {
    const interval = requiredString(modeRaw?.interval ?? raw.interval, "trigger.delivery.interval");
    parseDuration(interval);
    return { strategy, interval, collect: booleanOr(modeRaw?.collect ?? raw.collect, false) };
  }
  if (strategy === "batched") {
    const window = requiredString(modeRaw?.window ?? raw.window, "trigger.delivery.window");
    parseDuration(window);
    return { strategy, window, maxBatch: Math.max(1, numberOr(modeRaw?.maxBatch ?? modeRaw?.max_batch ?? raw.maxBatch ?? raw.max_batch, 1)) };
  }
  if (strategy === "debounced") {
    const quietPeriod = requiredString(
      modeRaw?.quietPeriod ?? modeRaw?.quiet_period ?? raw.quietPeriod ?? raw.quiet_period,
      "trigger.delivery.quietPeriod",
    );
    parseDuration(quietPeriod);
    return { strategy, quietPeriod };
  }
  throw new Error(`Unsupported delivery mode: ${strategy || "(missing)"}`);
}

function normalizeFilter(raw: AnyRecord | undefined): Filter | undefined {
  if (!raw) return undefined;
  return raw as Filter;
}

function normalizeContext(raw: AnyRecord | undefined): ContextResolver | undefined {
  if (!raw) return undefined;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.map((entry, index) => normalizeContextSource(asRecord(entry, `trigger.context.sources[${index}]`)))
    : undefined;
  return {
    sources,
    static: stringRecord(asOptionalRecord(raw.static)),
  };
}

function normalizeContextSource(raw: AnyRecord): ContextSource {
  const kind = stringOr(raw.kind, "");
  const variable = requiredString(raw.var, "context source var");
  if (kind === "command") {
    return { var: variable, kind, command: requiredString(raw.command, "context command"), cwd: optionalString(raw.cwd), timeout: optionalString(raw.timeout) };
  }
  if (kind === "http") {
    return { var: variable, kind, url: requiredString(raw.url, "context url"), jsonpath: optionalString(raw.jsonpath), timeout: optionalString(raw.timeout) };
  }
  if (kind === "file") return { var: variable, kind, path: requiredString(raw.path, "context file path"), timeout: optionalString(raw.timeout) };
  if (kind === "honeybee") return { var: variable, kind, query: requiredString(raw.query, "context honeybee query"), timeout: optionalString(raw.timeout) };
  throw new Error(`Unsupported context source kind: ${kind || "(missing)"}`);
}

function normalizeAction(raw: AnyRecord): Action {
  const kind = stringOr(raw.kind, "");
  if (kind === "command") {
    return {
      kind,
      command: requiredString(raw.command, "trigger.action.command"),
      cwd: optionalString(raw.cwd),
      timeout: optionalString(raw.timeout),
    };
  }
  if (kind === "http") {
    return {
      kind,
      method: stringOr(raw.method, "POST"),
      url: requiredString(raw.url, "trigger.action.url"),
      headers: stringRecord(asOptionalRecord(raw.headers)),
      body: optionalString(raw.body),
      timeout: optionalString(raw.timeout),
    };
  }
  if (kind === "honeybee") {
    const run = stringOr(raw.run, "");
    if (run === "flow") {
      return { kind, run, flow: requiredString(raw.flow, "trigger.action.flow"), args: stringRecord(asOptionalRecord(raw.args)) };
    }
    if (run === "loop") {
      return { kind, run, loop: (asOptionalRecord(raw.loop) ?? {}) as Record<string, JsonValue> };
    }
    throw new Error(`Unsupported honeybee run mode: ${run || "(missing)"}`);
  }
  if (kind === "hermes") {
    return { kind, invoke: requiredString(raw.invoke, "trigger.action.invoke"), payload: optionalString(raw.payload), timeout: optionalString(raw.timeout) };
  }
  if (kind === "emit") {
    return { kind, subject: requiredString(raw.subject, "trigger.action.subject"), payload: optionalString(raw.payload) };
  }
  throw new Error(`Unsupported action kind: ${kind || "(missing)"}`);
}

function normalizeMissedFirePolicy(value: unknown): ScheduleTiming["missedFirePolicy"] | undefined {
  if (value === undefined) return undefined;
  const policy = String(value);
  if (policy === "skip" || policy === "fire-once" || policy === "fire-all") return policy;
  throw new Error(`Unsupported missed-fire policy: ${policy}`);
}

function stripRuntimeDates(trigger: Trigger): AnyRecord {
  return {
    id: trigger.id,
    name: trigger.name,
    description: trigger.description,
    cwd: trigger.cwd,
    tags: trigger.tags,
    enabled: trigger.enabled,
    source: trigger.source,
    filter: trigger.filter,
    delivery: deliveryToToml(trigger.delivery),
    context: trigger.context,
    action: trigger.action,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
  };
}

function deliveryToToml(delivery: Delivery): AnyRecord {
  const { strategy } = delivery.mode;
  return {
    mode: strategy,
    maxConcurrent: delivery.maxConcurrent,
    ...Object.fromEntries(Object.entries(delivery.mode).filter(([key]) => key !== "strategy")),
  };
}

function asRecord(value: unknown, label: string): AnyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Expected table at ${label}`);
  return value as AnyRecord;
}

function asOptionalRecord(value: unknown): AnyRecord | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as AnyRecord;
}

function requiredString(value: unknown, label: string): string {
  const out = optionalString(value);
  if (!out) throw new Error(`Missing required string: ${label}`);
  return out;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return String(value);
}

function stringOr(value: unknown, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return fallback;
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function stringRecord(value: AnyRecord | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value).map(([key, val]) => [key, String(val)] as const);
  return Object.fromEntries(entries);
}
