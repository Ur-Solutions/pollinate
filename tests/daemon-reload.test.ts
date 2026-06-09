import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PollinateDaemon } from "../src/index.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

describe("daemon trigger reload", () => {
  test("running daemon autoloads a trigger added after startup", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(root, "pollinate.toml"),
        `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 20
contextTimeout = "1s"
commandTimeout = "1s"
`,
      );

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        const trig = trigger({
          id: "autoloaded",
          source: { kind: "schedule", timing: { type: "once", at: new Date(Date.now() + 50).toISOString() } },
          action: { kind: "emit", subject: "autoloaded", payload: "{{event}}" },
        });
        await store.saveTrigger(trig);

        const [job] = await waitForTerminalJobs(store, 1, 1_500);
        expect(job.triggerId).toBe("autoloaded");
      } finally {
        await daemon.stop();
      }
    });
  });

  test("running daemon starts polling a poll trigger added after startup", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(root, "pollinate.toml"),
        `
[webhook]
bind = "127.0.0.1"
port = 0

[defaults]
tickMs = 10
triggerReloadMs = 20
contextTimeout = "1s"
commandTimeout = "1s"
`,
      );
      const sourceFile = join(root, "events.jsonl");
      await writeFile(sourceFile, '{"id":1}\n');

      const daemon = new PollinateDaemon(store);
      await daemon.start();
      try {
        const trig = trigger({
          id: "autoloaded-poll",
          source: {
            kind: "poll",
            poll: {
              interval: "1s",
              emit: "per-item",
              fetch: { kind: "file", path: sourceFile },
              cursor: { strategy: "append-offset" },
            },
          },
          action: { kind: "emit", subject: "autoloaded-poll", payload: "{{event}}" },
        });
        await store.saveTrigger(trig);

        const [job] = await waitForTerminalJobs(store, 1, 1_500);
        expect(job.triggerId).toBe("autoloaded-poll");
      } finally {
        await daemon.stop();
      }
    });
  });
});
