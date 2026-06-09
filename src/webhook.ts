import { createHmac, timingSafeEqual } from "node:crypto";
import http, { IncomingMessage, ServerResponse } from "node:http";
import type { Activation, JsonObject, JsonValue, Trigger, WebhookSpec } from "./types.js";
import { DeliveryManager } from "./delivery.js";
import { PollinateStore } from "./store.js";
import { selectJsonPath } from "./jsonpath.js";
import { nowIso } from "./time.js";

export class WebhookServer {
  private server?: http.Server;

  constructor(
    private readonly store: PollinateStore,
    private readonly delivery: DeliveryManager,
    private triggers: Trigger[],
    private readonly bind: string,
    private readonly port: number,
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
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
    if (request.method !== "POST") {
      send(response, 405, { error: "method not allowed" });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const path = decodeURIComponent(url.pathname.replace(/^\/hook\/?/, ""));
    const trigger = this.triggers.find((item) => item.enabled && item.source.kind === "webhook" && item.source.webhook.path === path);
    if (!trigger || trigger.source.kind !== "webhook") {
      send(response, 404, { error: "hook not found" });
      return;
    }
    const raw = await readBody(request);
    try {
      if (!validSignature(trigger.source.webhook, raw, request.headers)) {
        send(response, 403, { error: "invalid signature" });
        return;
      }
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let payload: JsonValue;
    try {
      payload = raw.length ? (JSON.parse(raw.toString("utf8")) as JsonValue) : {};
    } catch {
      send(response, 400, { error: "invalid json" });
      return;
    }
    const transformed = applyWebhookTransform(trigger.source.webhook, payload);
    send(response, 202, { accepted: true, trigger_id: trigger.id });
    await this.store.appendLedger({
      event: "pollinate.webhook.received",
      trigger_id: trigger.id,
      path,
      source_ip: request.socket.remoteAddress,
      at: nowIso(),
      response_ms: Date.now() - started,
    });
    void this.dispatch(trigger, transformed, request.socket.remoteAddress ?? "unknown");
  }

  private async dispatch(trigger: Trigger, payload: JsonValue, _sourceIp: string): Promise<void> {
    const activation: Activation = { triggerId: trigger.id, source: "webhook", payload, receivedAt: nowIso() };
    await this.delivery.handle(trigger, activation);
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
  const signature = headerValue(headers["x-pollinate-signature"] ?? headers["x-hub-signature-256"] ?? headers["x-signature"]);
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const received = signature.replace(/^sha256=/, "");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function resolveSecret(value: string): string {
  if (!value.startsWith("env:")) return value;
  const envName = value.slice("env:".length);
  const secret = process.env[envName];
  if (!secret) throw new Error(`Webhook secret env var is not set: ${envName}`);
  return secret;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}
