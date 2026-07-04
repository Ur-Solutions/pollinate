import { describe, expect, test } from "vitest";
import {
  RELAY_SIGNATURE_HEADER,
  RELAY_TIMESTAMP_HEADER,
  SatelliteServer,
  relaySignatureHeaders,
  validRelaySignature,
} from "../src/index.js";

describe("satellite relay signatures", () => {
  test("rejects expired, future, and missing relay timestamps", () => {
    const secret = "relay-secret";
    const path = "github/repo";
    const raw = Buffer.from('{"ok":true}');
    const nowMs = 2_000_000_000_000;

    const valid = relaySignatureHeaders(secret, path, raw, nowMs);
    expect(validRelaySignature({ secret, path, raw, headers: valid, maxAgeSeconds: 300, nowMs })).toBe(true);

    const expired = relaySignatureHeaders(secret, path, raw, nowMs - 301_000);
    expect(validRelaySignature({ secret, path, raw, headers: expired, maxAgeSeconds: 300, nowMs })).toBe(false);

    const future = relaySignatureHeaders(secret, path, raw, nowMs + 301_000);
    expect(validRelaySignature({ secret, path, raw, headers: future, maxAgeSeconds: 300, nowMs })).toBe(false);

    expect(
      validRelaySignature({
        secret,
        path,
        raw,
        headers: { [RELAY_SIGNATURE_HEADER]: valid[RELAY_SIGNATURE_HEADER] },
        maxAgeSeconds: 300,
        nowMs,
      }),
    ).toBe(false);

    expect(
      validRelaySignature({
        secret,
        path,
        raw,
        headers: { ...valid, [RELAY_TIMESTAMP_HEADER]: "not-a-timestamp" },
        maxAgeSeconds: 300,
        nowMs,
      }),
    ).toBe(false);
  });
});

describe("satellite server", () => {
  test("serves healthz and rejects unsupported methods or routes", async () => {
    const satellite = new SatelliteServer({
      bind: "127.0.0.1",
      port: 0,
      target: "http://127.0.0.1:9",
      relaySecret: "relay",
    });
    await satellite.start();
    try {
      const address = satellite.address();
      expect(address).not.toBeNull();
      const base = `http://127.0.0.1:${address?.port}`;

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ ok: true });

      const method = await fetch(`${base}/hook/github`, { method: "GET" });
      expect(method.status).toBe(405);
      await expect(method.json()).resolves.toEqual({ error: "method not allowed" });

      const missing = await fetch(`${base}/`, { method: "POST", body: "{}" });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toEqual({ error: "hook not found" });
    } finally {
      await satellite.stop();
    }
  });
});
