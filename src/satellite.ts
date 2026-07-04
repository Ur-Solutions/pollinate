import { createHmac, timingSafeEqual } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { resolveSecret } from "./secrets.js";

export const RELAY_SIGNATURE_HEADER = "x-pollinate-relay-signature";
export const RELAY_TIMESTAMP_HEADER = "x-pollinate-relay-timestamp";
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_HEADERS_COUNT = 64;
let satelliteProcessGuardsInstalled = false;

export type SatelliteServerOptions = {
  bind: string;
  port: number;
  target: string;
  relaySecret: string;
  forwardTimeoutMs?: number;
};

type HeaderMap = IncomingHttpHeaders | Record<string, string | string[] | undefined>;

export class SatelliteServer {
  private server?: http.Server;

  constructor(private readonly options: SatelliteServerOptions) {}

  async start(): Promise<void> {
    if (shouldInstallSatelliteProcessGuards()) installSatelliteProcessGuards();
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.requestTimeout = REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = HEADERS_TIMEOUT_MS;
    this.server.maxHeadersCount = MAX_HEADERS_COUNT;
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, this.options.bind, () => {
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

  address(): { address: string; port: number } | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    return { address: address.address, port: address.port };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        send(response, 200, { ok: true });
        return;
      }
      if (request.method !== "POST") {
        send(response, 405, { error: "method not allowed" });
        return;
      }

      const path = satellitePath(request);
      if (!path) {
        send(response, 404, { error: "hook not found" });
        return;
      }

      const raw = await readBody(request);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.forwardTimeoutMs ?? 10_000);
      try {
        const upstream = await fetch(joinRelayTarget(this.options.target, path), {
          method: "POST",
          headers: {
            ...forwardHeaders(request.headers),
            ...relaySignatureHeaders(this.options.relaySecret, path, raw),
          },
          body: raw,
          signal: controller.signal,
        });
        const body = await upstream.text();
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        response.end(body || `${JSON.stringify({ forwarded: upstream.ok, upstream_status: upstream.status })}\n`);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      send(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function relaySignatureHeaders(secret: string, path: string, raw: Buffer, nowMs = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    [RELAY_TIMESTAMP_HEADER]: timestamp,
    [RELAY_SIGNATURE_HEADER]: relaySignature(secret, path, raw, timestamp),
  };
}

export function relaySignature(secret: string, path: string, raw: Buffer, timestamp: string): string {
  const hmac = createHmac("sha256", resolveSecret(secret));
  hmac.update(timestamp);
  hmac.update(".");
  hmac.update(normalizeRelayPath(path));
  hmac.update(".");
  hmac.update(raw);
  return `sha256=${hmac.digest("hex")}`;
}

export function validRelaySignature(options: {
  secret?: string;
  path: string;
  raw: Buffer;
  headers: HeaderMap;
  maxAgeSeconds?: number;
  nowMs?: number;
}): boolean {
  if (!options.secret) return false;
  const timestamp = headerValue(options.headers[RELAY_TIMESTAMP_HEADER]);
  const signature = headerValue(options.headers[RELAY_SIGNATURE_HEADER]);
  if (!timestamp || !signature) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const maxAgeMs = (options.maxAgeSeconds ?? 300) * 1000;
  if (Math.abs((options.nowMs ?? Date.now()) - timestampSeconds * 1000) > maxAgeMs) return false;

  const expected = relaySignature(options.secret, options.path, options.raw, timestamp).replace(/^sha256=/, "");
  const received = signature.replace(/^sha256=/, "");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function satellitePath(request: IncomingMessage): string | null {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const route = routePath(url.pathname, "hook") ?? routePath(url.pathname, "satellite");
  return route ? normalizeRelayPath(route) : null;
}

function routePath(pathname: string, prefix: string): string | null {
  const marker = `/${prefix}/`;
  if (!pathname.startsWith(marker)) return null;
  const raw = pathname.slice(marker.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid route encoding");
  }
}

function joinRelayTarget(target: string, path: string): string {
  return `${target.replace(/\/+$/, "")}/relay/${encodePath(path)}`;
}

function encodePath(path: string): string {
  return normalizeRelayPath(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function normalizeRelayPath(path: string): string {
  return path.replace(/^\/+/, "");
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const allow = [
    "content-type",
    "x-github-delivery",
    "x-github-event",
    "x-gitlab-event",
    "x-gitlab-token",
    "x-hub-signature-256",
    "x-pollinate-signature",
    "x-vercel-signature",
    "x-signature",
    "user-agent",
  ];
  const forwarded: Record<string, string> = {};
  for (const name of allow) {
    const value = headerValue(headers[name]);
    if (value) forwarded[name] = value;
  }
  return forwarded;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

function shouldInstallSatelliteProcessGuards(): boolean {
  return process.argv.includes("satellite") && process.argv.includes("run");
}

function installSatelliteProcessGuards(): void {
  if (satelliteProcessGuardsInstalled) return;
  satelliteProcessGuardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    console.error(`pollinate satellite unhandled rejection: ${formatUnknownError(reason)}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`pollinate satellite uncaught exception: ${formatUnknownError(error)}`);
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
