import { randomBytes } from "node:crypto";
import type { Action, Delivery, Trigger } from "./types.js";
import { PollinateStore } from "./store.js";
import { isoAfter, nowIso, parseDuration } from "./time.js";

export type HookCreateOptions = {
  id: string;
  name?: string;
  path?: string;
  ttl?: string;
  baseUrl?: string;
  secret?: string;
  transform?: Record<string, string>;
  maxDeliveries?: number;
  action: Action;
  delivery?: Delivery;
  tags?: string[];
};

export type HookCreateResult = {
  id: string;
  path: string;
  url?: string;
  expiresAt?: string;
  maxDeliveries?: number;
  trigger: Trigger;
};

export function createWebhookHook(options: HookCreateOptions, now = new Date()): HookCreateResult {
  const path = normalizeHookPath(options.path ?? `tmp/${randomHookToken()}`);
  const ttlMs = options.ttl ? parseDuration(options.ttl) : undefined;
  const expiresAt = ttlMs === undefined ? undefined : isoAfter(ttlMs, now);
  const createdAt = now.toISOString();
  const trigger: Trigger = {
    id: options.id,
    name: options.name ?? options.id,
    tags: options.tags ?? [],
    enabled: true,
    source: { kind: "webhook", webhook: { path, secret: options.secret, transform: options.transform } },
    delivery: options.delivery ?? { mode: { strategy: "immediate" }, maxConcurrent: 1 },
    lifecycle: {
      temporary: true,
      expiresAt,
      maxDeliveries: options.maxDeliveries,
      deliveries: 0,
    },
    action: options.action,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    id: trigger.id,
    path,
    url: options.baseUrl ? hookUrl(options.baseUrl, path) : undefined,
    expiresAt,
    maxDeliveries: options.maxDeliveries,
    trigger,
  };
}

export function hookUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/hook/${normalizeHookPath(path).split("/").map(encodeURIComponent).join("/")}`;
}

export function randomHookToken(): string {
  return randomBytes(18).toString("hex");
}

export function normalizeHookPath(path: string): string {
  return path.replace(/^\/+/, "");
}

export function isExpiredTemporaryHook(trigger: Trigger, now = Date.now()): boolean {
  if (!trigger.lifecycle?.temporary || !trigger.lifecycle.expiresAt) return false;
  return new Date(trigger.lifecycle.expiresAt).getTime() <= now;
}

export async function expireTemporaryHook(store: PollinateStore, trigger: Trigger): Promise<Trigger> {
  if (!trigger.lifecycle?.temporary || !trigger.enabled) return trigger;
  const updated = { ...trigger, enabled: false, updatedAt: nowIso() };
  await store.saveTrigger(updated);
  await store.appendLedger({ event: "pollinate.hook.expired", trigger_id: trigger.id });
  return updated;
}

export async function recordWebhookDelivery(store: PollinateStore, trigger: Trigger): Promise<Trigger> {
  if (!trigger.lifecycle) return trigger;
  const deliveries = (trigger.lifecycle.deliveries ?? 0) + 1;
  const maxDeliveries = trigger.lifecycle.maxDeliveries;
  const maxReached = maxDeliveries !== undefined && deliveries >= maxDeliveries;
  const updated = {
    ...trigger,
    enabled: maxReached ? false : trigger.enabled,
    lifecycle: { ...trigger.lifecycle, deliveries },
    updatedAt: nowIso(),
  };
  await store.saveTrigger(updated);
  await store.appendLedger({
    event: "pollinate.hook.delivered",
    trigger_id: trigger.id,
    deliveries,
    max_deliveries: maxDeliveries,
    disabled: maxReached,
  });
  return updated;
}

export async function gcTemporaryHooks(store: PollinateStore, now = Date.now()): Promise<string[]> {
  const triggers = await store.loadTriggers();
  const removable = triggers
    .filter((trigger) => trigger.lifecycle?.temporary)
    .filter((trigger) => isExpiredTemporaryHook(trigger, now) || reachedMaxDeliveries(trigger))
    .map((trigger) => trigger.id)
    .sort();
  for (const id of removable) {
    await store.removeTrigger(id);
    await store.appendLedger({ event: "pollinate.hook.gc_removed", trigger_id: id });
  }
  return removable;
}

function reachedMaxDeliveries(trigger: Trigger): boolean {
  const max = trigger.lifecycle?.maxDeliveries;
  return max !== undefined && (trigger.lifecycle?.deliveries ?? 0) >= max;
}
