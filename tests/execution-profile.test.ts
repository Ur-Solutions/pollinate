import { describe, expect, test } from "vitest";
import {
  ActionExecutor,
  PollEngine,
  parseDaemonConfigToml,
  fetchPoll,
  type ExecutionProfile,
} from "../src/index.js";
import { DeliveryManager } from "../src/delivery.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

const testProfile: ExecutionProfile = {
  shell: "/bin/sh",
  shellArgs: ["-c"],
  inheritEnv: true,
  env: {
    POLLINATE_PROFILE_VALUE: "profile-ok",
  },
};

describe("execution profile", () => {
  test("daemon config parses shell, shell args, inherited env, and explicit env", () => {
    const config = parseDaemonConfigToml(`
[execution]
shell = "/bin/zsh"
shellArgs = ["-lc"]
inheritEnv = true

[webhook]
publicUrl = "https://hooks.example.com"

[execution.env]
PATH = "/custom/bin:/usr/bin:/bin"
POLLINATE_PROFILE_VALUE = "from-config"
`);
    expect(config.webhook.publicUrl).toBe("https://hooks.example.com");
    expect(config.execution).toEqual({
      shell: "/bin/zsh",
      shellArgs: ["-lc"],
      inheritEnv: true,
      env: {
        PATH: "/custom/bin:/usr/bin:/bin",
        POLLINATE_PROFILE_VALUE: "from-config",
      },
    });
  });

  test("command actions inherit execution profile env", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "profile-command",
        action: { kind: "command", command: "printf '%s' \"$POLLINATE_PROFILE_VALUE\"" },
      });
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000, execution: testProfile });
      const activation = { triggerId: trig.id, source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
      const job = await executor.createQueuedJob(trig, activation, [{}]);
      await store.saveJob(job);
      await executor.executeJob(job, trig, activation, [{}]);
      const [completed] = await waitForTerminalJobs(store, 1);
      expect(completed.result).toMatchObject({ stdout: "profile-ok" });
    });
  });

  test("poll command fetches inherit execution profile env", async () => {
    const fetched = await fetchPoll(
      {
        interval: "1m",
        emit: "per-item",
        fetch: { kind: "command", command: "printf '%s' \"$POLLINATE_PROFILE_VALUE\"" },
        cursor: { strategy: "hash" },
      },
      undefined,
      testProfile,
    );
    expect(fetched).toBe("profile-ok");
  });

  test("poll engine uses execution profile for command polls", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "profile-poll",
        source: {
          kind: "poll",
          poll: {
            interval: "1m",
            emit: "per-item",
            fetch: { kind: "command", command: "printf '%s\\n' \"$POLLINATE_PROFILE_VALUE\"" },
            cursor: { strategy: "hash" },
          },
        },
      });
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000, execution: testProfile }));
      await delivery.init([trig]);
      const poll = new PollEngine(store, delivery, [trig], testProfile);
      await poll.start();
      try {
        await poll.pollNow(trig);
        const [completed] = await waitForTerminalJobs(store, 1);
        expect(completed.context.event).toBe('"profile-ok"');
      } finally {
        await poll.stop();
        await delivery.shutdown();
      }
    });
  });
});
