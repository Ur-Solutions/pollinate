import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ActionExecutor,
  DeliveryManager,
  PollEngine,
  SatelliteServer,
  WebhookServer,
  detectDelta,
  fetchPoll,
  relaySignatureHeaders,
  validRelaySignature,
  validSignature,
  applyWebhookTransform,
  type CursorState,
} from "../src/index.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

describe("poll cursors", () => {
  test("append-offset advances and does not re-emit seen items after restart", () => {
    const spec = {
      interval: "1m",
      emit: "per-item" as const,
      fetch: { kind: "file" as const, path: "/tmp/example" },
      cursor: { strategy: "append-offset" as const },
    };
    let cursors: CursorState = {};
    const first = detectDelta(spec, "poller", "{\"id\":1}\n", cursors);
    expect(first.items).toEqual([{ id: 1 }]);
    cursors = first.cursors;

    const restart = detectDelta(spec, "poller", "{\"id\":1}\n", cursors);
    expect(restart.items).toEqual([]);

    const second = detectDelta(spec, "poller", "{\"id\":1}\n{\"id\":2}\n", restart.cursors);
    expect(second.items).toEqual([{ id: 2 }]);
  });

  test("jsonpath cursor emits only new selected ids", () => {
    const spec = {
      interval: "1m",
      emit: "per-item" as const,
      fetch: { kind: "command" as const, command: "unused" },
      cursor: { strategy: "jsonpath" as const, jsonpath: "$.hits[*].id" },
    };
    const first = detectDelta(spec, "search", JSON.stringify({ hits: [{ id: "a" }, { id: "b" }] }), {});
    expect(first.items).toEqual(["a", "b"]);
    const second = detectDelta(spec, "search", JSON.stringify({ hits: [{ id: "a" }, { id: "b" }, { id: "c" }] }), first.cursors);
    expect(second.items).toEqual(["c"]);
  });

  test("command poll fetch inherits trigger cwd by default", async () => {
    await withTempStore(async (_store, root) => {
      const repo = join(root, "repo");
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, "events.jsonl"), '{"id":1}\n');
      const fetched = await fetchPoll(
        {
          interval: "1m",
          emit: "per-item",
          fetch: { kind: "command", command: "node -e \"process.stdout.write(require('fs').readFileSync('events.jsonl'))\"" },
          cursor: { strategy: "append-offset" },
        },
        repo,
      );
      expect(fetched).toBe('{"id":1}\n');
    });
  });

  test("successful no-op polls are logged as checked events", async () => {
    await withTempStore(async (store, root) => {
      const sourceFile = join(root, "events.jsonl");
      const contents = '{"id":1}\n{"id":2}\n';
      await writeFile(sourceFile, contents);
      await store.writeCursorState({ noop: contents.length });
      const trig = trigger({
        id: "noop",
        source: {
          kind: "poll",
          poll: {
            interval: "1m",
            emit: "per-item",
            fetch: { kind: "file", path: sourceFile },
            cursor: { strategy: "append-offset" },
          },
        },
      });
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([trig]);
      const poll = new PollEngine(store, delivery, [trig]);
      await poll.start();
      try {
        const newCount = await poll.pollNow(trig);
        expect(newCount).toBe(0);
        const checked = (await store.readLedger())
          .map((line) => JSON.parse(line) as { event: string; trigger_id?: string; item_count?: number; new_count?: number })
          .find((event) => event.event === "pollinate.poll.checked");
        expect(checked).toMatchObject({ trigger_id: "noop", item_count: 2, new_count: 0 });
      } finally {
        await poll.stop();
        await delivery.shutdown();
      }
    });
  });
});

describe("webhooks", () => {
  test("validates HMAC signatures and applies transforms", () => {
    const raw = Buffer.from(JSON.stringify({ message: { text: "hi", chat: { id: 42 } } }));
    const secret = "secret";
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const vercelSignature = createHmac("sha1", secret).update(raw).digest("hex");
    const spec = { path: "telegram", secret, transform: { text: "$.message.text", chat_id: "$.message.chat.id" } };

    expect(validSignature(spec, raw, { "x-pollinate-signature": signature })).toBe(true);
    expect(validSignature(spec, raw, { "x-vercel-signature": vercelSignature })).toBe(true);
    expect(validSignature(spec, raw, { "x-pollinate-signature": "sha256=00" })).toBe(false);
    expect(applyWebhookTransform(spec, JSON.parse(raw.toString()))).toEqual({ text: "hi", chat_id: 42 });
  });

  test("HTTP webhook rejects invalid signatures and accepts valid ones asynchronously", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "hook",
        source: { kind: "webhook", webhook: { path: "in", secret: "top" } },
        action: { kind: "emit", subject: "hook", payload: "{{event}}" },
      });
      await store.saveTrigger(trig);
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const delivery = new DeliveryManager(store, executor);
      await delivery.init([trig]);
      const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
      await server.start();
      try {
        const address = server.address();
        expect(address).not.toBeNull();
        const url = `http://127.0.0.1:${address?.port}/hook/in`;
        const body = JSON.stringify({ ok: true });
        const invalid = await fetch(url, { method: "POST", body, headers: { "x-pollinate-signature": "sha256=00" } });
        expect(invalid.status).toBe(403);

        const sig = `sha256=${createHmac("sha256", "top").update(body).digest("hex")}`;
        const started = Date.now();
        const valid = await fetch(url, { method: "POST", body, headers: { "x-pollinate-signature": sig } });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(valid.status).toBe(202);
        await waitForTerminalJobs(store, 1);
      } finally {
        await server.stop();
        await delivery.shutdown();
      }
    });
  });

  test("one-shot webhook triggers disable themselves after the first accepted delivery", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "one-shot",
        source: { kind: "webhook", webhook: { path: "tmp/one-shot" } },
        lifecycle: { temporary: true, maxDeliveries: 1, deliveries: 0 },
        action: { kind: "emit", subject: "hook", payload: "{{event}}" },
      });
      await store.saveTrigger(trig);
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const delivery = new DeliveryManager(store, executor);
      await delivery.init([trig]);
      const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
      await server.start();
      try {
        const address = server.address();
        expect(address).not.toBeNull();
        const url = `http://127.0.0.1:${address?.port}/hook/tmp/one-shot`;

        const accepted = await fetch(url, { method: "POST", body: JSON.stringify({ ok: true }) });
        expect(accepted.status).toBe(202);
        await waitForTerminalJobs(store, 1);

        const updated = await store.requireTrigger("one-shot");
        expect(updated.enabled).toBe(false);
        expect(updated.lifecycle).toMatchObject({ temporary: true, maxDeliveries: 1, deliveries: 1 });

        const second = await fetch(url, { method: "POST", body: JSON.stringify({ ok: false }) });
        expect(second.status).toBe(404);
      } finally {
        await server.stop();
        await delivery.shutdown();
      }
    });
  });

  test("local webhook relay requires satellite signature before dispatching", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "relay-hook",
        source: { kind: "webhook", webhook: { path: "github", secret: "provider" } },
        action: { kind: "emit", subject: "hook", payload: "{{event}}" },
      });
      await store.saveTrigger(trig);
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const delivery = new DeliveryManager(store, executor);
      await delivery.init([trig]);
      const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0, { secret: "relay", maxAgeSeconds: 300 });
      await server.start();
      try {
        const address = server.address();
        expect(address).not.toBeNull();
        const url = `http://127.0.0.1:${address?.port}/relay/github`;
        const body = JSON.stringify({ ok: true });
        const providerSig = `sha256=${createHmac("sha256", "provider").update(body).digest("hex")}`;

        const invalidRelay = await fetch(url, {
          method: "POST",
          body,
          headers: { "x-hub-signature-256": providerSig, "x-pollinate-relay-signature": "sha256=00" },
        });
        expect(invalidRelay.status).toBe(403);

        const validRelay = await fetch(url, {
          method: "POST",
          body,
          headers: { "x-hub-signature-256": providerSig, ...relaySignatureHeaders("relay", "github", Buffer.from(body)) },
        });
        expect(validRelay.status).toBe(202);
        await waitForTerminalJobs(store, 1);
      } finally {
        await server.stop();
        await delivery.shutdown();
      }
    });
  });

  test("satellite forwards public hooks to the local signed relay endpoint", async () => {
    const received: { url?: string; body?: Buffer; headers?: Record<string, string | string[] | undefined> } = {};
    const upstream = await new Promise<import("node:http").Server>((resolve) => {
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.url = request.url;
          received.body = Buffer.concat(chunks);
          received.headers = request.headers;
          response.writeHead(202, { "content-type": "application/json" });
          response.end('{"accepted":true}\n');
        });
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("expected upstream address");
    const satellite = new SatelliteServer({
      bind: "127.0.0.1",
      port: 0,
      target: `http://127.0.0.1:${upstreamAddress.port}`,
      relaySecret: "relay",
    });
    await satellite.start();
    try {
      const address = satellite.address();
      expect(address).not.toBeNull();
      const body = Buffer.from(JSON.stringify({ event: "opened" }));
      const providerSig = `sha256=${createHmac("sha256", "provider").update(body).digest("hex")}`;
      const vercelSig = createHmac("sha1", "vercel").update(body).digest("hex");
      const response = await fetch(`http://127.0.0.1:${address?.port}/hook/github`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", "x-hub-signature-256": providerSig, "x-vercel-signature": vercelSig },
      });

      expect(response.status).toBe(202);
      expect(received.url).toBe("/relay/github");
      expect(received.body?.toString("utf8")).toBe(body.toString("utf8"));
      expect(received.headers?.["x-hub-signature-256"]).toBe(providerSig);
      expect(received.headers?.["x-vercel-signature"]).toBe(vercelSig);
      expect(
        validRelaySignature({
          secret: "relay",
          path: "github",
          raw: received.body ?? Buffer.alloc(0),
          headers: received.headers ?? {},
        }),
      ).toBe(true);
    } finally {
      await satellite.stop();
      await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
