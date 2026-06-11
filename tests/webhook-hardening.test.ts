import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ActionExecutor, DeliveryManager, WebhookServer } from "../src/index.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

async function withServer(
  store: Parameters<Parameters<typeof withTempStore>[0]>[0],
  trig: ReturnType<typeof trigger>,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  await store.saveTrigger(trig);
  const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
  await delivery.init([trig]);
  const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
  await server.start();
  try {
    const address = server.address();
    if (!address) throw new Error("server did not bind");
    const path = trig.source.kind === "webhook" ? trig.source.webhook.path : "";
    await fn(`http://127.0.0.1:${address.port}/hook/${path}`);
  } finally {
    await server.stop();
    await delivery.shutdown();
  }
}

describe("webhook hardening", () => {
  test("redelivered x-github-delivery GUIDs are accepted but not dispatched twice", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "dedup", source: { kind: "webhook", webhook: { path: "dedup" } } });
      await withServer(store, trig, async (url) => {
        const body = JSON.stringify({ n: 1 });
        const headers = { "content-type": "application/json", "x-github-delivery": "guid-123" };
        const first = await fetch(url, { method: "POST", headers, body });
        expect(first.status).toBe(202);
        expect(await first.json()).toMatchObject({ accepted: true });

        const second = await fetch(url, { method: "POST", headers, body });
        expect(second.status).toBe(202);
        expect(await second.json()).toMatchObject({ accepted: true, duplicate: true });

        await waitForTerminalJobs(store, 1);
        expect(await store.listJobs()).toHaveLength(1);
        const ledger = (await store.readLedger()).join("\n");
        expect(ledger).toContain("pollinate.webhook.duplicate");
        expect(ledger).toContain("guid-123");
      });
    });
  });

  test("distinct delivery GUIDs dispatch independently", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "dedup-distinct", source: { kind: "webhook", webhook: { path: "dedup-distinct" } } });
      await withServer(store, trig, async (url) => {
        const headers = { "content-type": "application/json" };
        await fetch(url, { method: "POST", headers: { ...headers, "x-github-delivery": "guid-a" }, body: "{}" });
        await fetch(url, { method: "POST", headers: { ...headers, "x-github-delivery": "guid-b" }, body: "{}" });
        await waitForTerminalJobs(store, 2);
        expect(await store.listJobs()).toHaveLength(2);
      });
    });
  });

  test("signature rejections are ledgered with a reason", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "secured", source: { kind: "webhook", webhook: { path: "secured", secret: "s3cret" } } });
      await withServer(store, trig, async (url) => {
        const missing = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        expect(missing.status).toBe(403);

        const forged = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
          body: "{}",
        });
        expect(forged.status).toBe(403);

        const ledger = (await store.readLedger()).join("\n");
        const rejections = ledger.match(/pollinate\.webhook\.rejected/g) ?? [];
        expect(rejections).toHaveLength(2);
        expect(ledger).toContain("invalid-signature");
        expect(await store.listJobs()).toHaveLength(0);

        const signature = createHmac("sha256", "s3cret").update(Buffer.from("{}")).digest("hex");
        const valid = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
          body: "{}",
        });
        expect(valid.status).toBe(202);
        await waitForTerminalJobs(store, 1);
      });
    });
  });
});
