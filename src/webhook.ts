import { createHmac, timingSafeEqual } from "node:crypto";
import http, { IncomingMessage, ServerResponse } from "node:http";
import type { Activation, JsonObject, JsonValue, Trigger, WebhookRelayConfig, WebhookSpec } from "./types.js";
import { DeliveryManager } from "./delivery.js";
import { PollinateStore } from "./store.js";
import { selectJsonPath } from "./jsonpath.js";
import { nowIso } from "./time.js";
import { resolveSecret } from "./secrets.js";
import { validRelaySignature } from "./satellite.js";
import { expireTemporaryHook, isExpiredTemporaryHook, recordWebhookDelivery } from "./hooks.js";

const MAX_SEEN_DELIVERIES = 1_000;
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_HEADERS_COUNT = 64;
const ROUTER_BINDING_CAP = 100;
const ROUTER_CREATION_WINDOW_MS = 60_000;
const ROUTER_CREATION_LIMIT = 30;

export class WebhookServer {
  private server?: http.Server;
  /** Recently seen webhook delivery GUIDs (`<triggerId>:<x-github-delivery>`), insertion-ordered for eviction. */
  private readonly seenDeliveries = new Set<string>();
  private readonly routerAdmission = new Map<string, number[]>();

  constructor(
    private readonly store: PollinateStore,
    private readonly delivery: DeliveryManager,
    private triggers: Trigger[],
    private readonly bind: string,
    private readonly port: number,
    private readonly relay: WebhookRelayConfig = { maxAgeSeconds: 300 },
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.requestTimeout = REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = HEADERS_TIMEOUT_MS;
    this.server.maxHeadersCount = MAX_HEADERS_COUNT;
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, this.bind, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }

  updateTriggers(triggers: Trigger[]): void {
    this.triggers = triggers;
  }

  address(): { address: string; port: number } | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    return { address: address.address, port: address.port };
  }

  routes(): Array<{ triggerId: string; path: string; secretConfigured: boolean }> {
    return this.triggers
      .filter((trigger) => trigger.source.kind === "webhook")
      .map((trigger) => ({
        triggerId: trigger.id,
        path: `/hook/${trigger.source.kind === "webhook" ? trigger.source.webhook.path : ""}`,
        secretConfigured: Boolean(trigger.source.kind === "webhook" && trigger.source.webhook.secret),
      }));
  }

  async test(trigger: Trigger, payload: JsonValue): Promise<void> {
    if (trigger.source.kind !== "webhook") throw new Error(`Trigger ${trigger.id} is not a webhook trigger`);
    const transformed = applyWebhookTransform(trigger.source.webhook, payload);
    await this.dispatch(trigger, transformed, "test");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    try {
      if (request.method !== "POST") {
        send(response, 405, { error: "method not allowed" });
        return;
      }
      const route = webhookRoute(request);
      if (!route) {
        send(response, 404, { error: "hook not found" });
        return;
      }
      const { path } = route;
      const trigger = this.triggers.find((item) => item.enabled && item.source.kind === "webhook" && item.source.webhook.path === path);
      if (!trigger || trigger.source.kind !== "webhook") {
        send(response, 404, { error: "hook not found" });
        return;
      }
      if (isExpiredTemporaryHook(trigger)) {
        const expired = await expireTemporaryHook(this.store, trigger);
        this.replaceTrigger(expired);
        send(response, 410, { error: "hook expired" });
        return;
      }
      if (requiresSecret(trigger, route, request)) {
        await this.ledgerRejection(trigger.id, path, "missing-secret", request);
        send(response, 403, { error: "webhook secret required" });
        return;
      }
      const raw = await readBody(request);
      if (route.kind === "relay") {
        if (!this.relay.secret) {
          await this.ledgerRejection(trigger.id, path, "relay-not-enabled", request);
          send(response, 404, { error: "relay not enabled" });
          return;
        }
        if (!validRelaySignature({ secret: this.relay.secret, maxAgeSeconds: this.relay.maxAgeSeconds, path, raw, headers: request.headers })) {
          await this.ledgerRejection(trigger.id, path, "invalid-relay-signature", request);
          send(response, 403, { error: "invalid relay signature" });
          return;
        }
      }
      if (requiresSecret(trigger, route, request)) {
        await this.ledgerRejection(trigger.id, path, "missing-secret", request);
        send(response, 403, { error: "webhook secret required" });
        return;
      }
      if (!validSignature(trigger.source.webhook, raw, request.headers)) {
        await this.ledgerRejection(trigger.id, path, "invalid-signature", request);
        send(response, 403, { error: "invalid signature" });
        return;
      }
      let payload: JsonValue;
      try {
        payload = raw.length ? (JSON.parse(raw.toString("utf8")) as JsonValue) : {};
      } catch {
        send(response, 400, { error: "invalid json" });
        return;
      }
      const deliveryId = headerValue(request.headers["x-github-delivery"]);
      if (deliveryId && this.isDuplicateDelivery(trigger.id, deliveryId)) {
        send(response, 202, { accepted: true, duplicate: true, trigger_id: trigger.id });
        await this.store.appendLedger({
          event: "pollinate.webhook.duplicate",
          trigger_id: trigger.id,
          path,
          delivery_id: deliveryId,
          source_ip: request.socket.remoteAddress,
        });
        return;
      }
      if (!(await this.admitRouterDelivery(trigger, path, request, response))) return;
      const dispatchTrigger = trigger;
      const transformed = trigger.router ? payload : applyWebhookTransform(trigger.source.webhook, payload);
      const updated = await recordWebhookDelivery(this.store, trigger);
      this.replaceTrigger(updated);
      send(response, 202, { accepted: true, trigger_id: trigger.id });
      await this.store.appendLedger({
        event: "pollinate.webhook.received",
        trigger_id: trigger.id,
        path,
        source_ip: request.socket.remoteAddress,
        at: nowIso(),
        response_ms: Date.now() - started,
      });
      void this.dispatch(dispatchTrigger, transformed, request.socket.remoteAddress ?? "unknown", {
        path,
        headers: normalizedHeaders(request.headers),
      }).catch((error) =>
        this.store.appendLedger({
          event: "pollinate.webhook.rejected",
          trigger_id: dispatchTrigger.id,
          path,
          reason: "dispatch-error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      send(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async dispatch(
    trigger: Trigger,
    payload: JsonValue,
    _sourceIp: string,
    webhook?: { path?: string; headers?: Record<string, string> },
  ): Promise<void> {
    const activation: Activation = { triggerId: trigger.id, source: "webhook", payload, receivedAt: nowIso(), metadata: webhook ? { webhook } : undefined };
    await this.delivery.handle(trigger, activation);
  }

  private replaceTrigger(updated: Trigger): void {
    this.triggers = this.triggers.map((trigger) => (trigger.id === updated.id ? updated : trigger));
  }

  private isDuplicateDelivery(triggerId: string, deliveryId: string): boolean {
    const key = `${triggerId}:${deliveryId}`;
    if (this.seenDeliveries.has(key)) return true;
    this.seenDeliveries.add(key);
    while (this.seenDeliveries.size > MAX_SEEN_DELIVERIES) {
      const oldest = this.seenDeliveries.values().next().value;
      if (oldest === undefined) break;
      this.seenDeliveries.delete(oldest);
    }
    return false;
  }

  private async ledgerRejection(triggerId: string, path: string, reason: string, request: IncomingMessage): Promise<void> {
    await this.store.appendLedger({
      event: "pollinate.webhook.rejected",
      trigger_id: triggerId,
      path,
      reason,
      source_ip: request.socket.remoteAddress,
    });
  }

  private async admitRouterDelivery(trigger: Trigger, path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!trigger.router) return true;
    const bindings = await this.store.listRouterBindings({ triggerId: trigger.id });
    const openBindings = bindings.filter((binding) => binding.status !== "closed");
    if (openBindings.length >= ROUTER_BINDING_CAP) {
      await this.ledgerRejection(trigger.id, path, "router-binding-cap", request);
      send(response, 429, { error: "router binding cap reached" });
      return false;
    }
    const now = Date.now();
    const recent = (this.routerAdmission.get(trigger.id) ?? []).filter((at) => now - at < ROUTER_CREATION_WINDOW_MS);
    if (recent.length >= ROUTER_CREATION_LIMIT) {
      this.routerAdmission.set(trigger.id, recent);
      await this.ledgerRejection(trigger.id, path, "router-rate-limited", request);
      send(response, 429, { error: "router rate limit exceeded" });
      return false;
    }
    recent.push(now);
    this.routerAdmission.set(trigger.id, recent);
    return true;
  }
}

type WebhookRoute = { kind: "hook" | "relay"; path: string };

function webhookRoute(request: IncomingMessage): WebhookRoute | null {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const hook = routePath(url.pathname, "hook");
  if (hook) return { kind: "hook", path: hook };
  const relay = routePath(url.pathname, "relay");
  if (relay) return { kind: "relay", path: relay };
  return null;
}

function routePath(pathname: string, prefix: string): string | null {
  const marker = `/${prefix}/`;
  if (!pathname.startsWith(marker)) return null;
  const raw = pathname.slice(marker.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).replace(/^\/+/, "");
  } catch {
    throw new HttpError(400, "invalid route encoding");
  }
}

export function applyWebhookTransform(spec: WebhookSpec, payload: JsonValue): JsonValue {
  if (!spec.transform || Object.keys(spec.transform).length === 0) return payload;
  const out: JsonObject = {};
  for (const [key, path] of Object.entries(spec.transform)) {
    const selected = selectJsonPath(path, payload);
    out[key] = normalizeJsonValue(selected);
  }
  return out;
}

export function validSignature(spec: WebhookSpec, raw: Buffer, headers: IncomingMessage["headers"]): boolean {
  if (!spec.secret) return true;
  const secret = resolveSecret(spec.secret);
  const vercelSignature = headerValue(headers["x-vercel-signature"]);
  if (vercelSignature) return validHexHmacSignature("sha1", secret, raw, vercelSignature);
  const signature = headerValue(headers["x-pollinate-signature"] ?? headers["x-hub-signature-256"] ?? headers["x-signature"]);
  if (!signature) return false;
  return validHexHmacSignature("sha256", secret, raw, signature);
}

function validHexHmacSignature(algorithm: "sha1" | "sha256", secret: string, raw: Buffer, signature: string): boolean {
  const expected = createHmac(algorithm, secret).update(raw).digest("hex");
  const received = signature.replace(/^sha(?:1|256)=/, "");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizedHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const selected = headerValue(value);
    if (selected !== undefined) out[key.toLowerCase()] = selected;
  }
  return out;
}

function normalizeJsonValue(value: unknown): JsonValue {
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

function readBody(request: IncomingMessage, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<Buffer> {
  const contentLength = headerValue(request.headers["content-length"]);
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0) throw new HttpError(400, "invalid content-length");
    if (declared > maxBytes) throw new HttpError(413, "request body too large");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        done(() => reject(new HttpError(413, "request body too large")));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("aborted", () => done(() => reject(new HttpError(400, "request aborted"))));
    request.on("error", (error) => done(() => reject(error)));
    request.on("end", () => done(() => resolve(Buffer.concat(chunks))));
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requiresSecret(trigger: Trigger, route: WebhookRoute, request: IncomingMessage): boolean {
  if (trigger.source.kind !== "webhook" || trigger.source.webhook.secret) return false;
  if (trigger.lifecycle?.temporary) return false;
  return route.kind === "relay" || !isLoopbackAddress(request.socket.remoteAddress);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return Boolean(address && (address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.")));
}
