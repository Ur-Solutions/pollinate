import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActionExecutor, DeliveryManager, detectDelta, fetchPoll, validSignature, applyWebhookTransform, WebhookServer, type CursorState } from "../src/index.js";
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
});

describe("webhooks", () => {
  test("validates HMAC signatures and applies transforms", () => {
    const raw = Buffer.from(JSON.stringify({ message: { text: "hi", chat: { id: 42 } } }));
    const secret = "secret";
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    const spec = { path: "telegram", secret, transform: { text: "$.message.text", chat_id: "$.message.chat.id" } };

    expect(validSignature(spec, raw, { "x-pollinate-signature": signature })).toBe(true);
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
});
