import { describe, expect, test } from "vitest";
import { ActionExecutor, isValidHiveHandle, parseHiveHandle, pathExists } from "../src/index.js";
import { join } from "node:path";
import { installHiveStub, withTempStore } from "./helpers.js";

describe("parseHiveHandle", () => {
  test("takes the first token of the first handle-shaped line", () => {
    expect(parseHiveHandle("pr-123\tcodex\t/tmp\tlocal\n")).toBe("pr-123");
    expect(parseHiveHandle("\n\n  bee.7:local  extra\n")).toBe("bee.7:local");
  });

  test("skips warning-style prefix lines", () => {
    expect(parseHiveHandle("warning: hive is out of date\npr-9\tcodex\n")).toBe("pr-9");
    expect(parseHiveHandle("Error:\n")).toBeUndefined();
  });

  test("returns undefined for output with no valid handle", () => {
    expect(parseHiveHandle("")).toBeUndefined();
    expect(parseHiveHandle("!! something exploded !!\n")).toBeUndefined();
    expect(parseHiveHandle("$(rm -rf /) oops\n")).toBeUndefined();
  });
});

describe("isValidHiveHandle", () => {
  test("accepts hive-style handles and rejects shell metacharacters", () => {
    expect(isValidHiveHandle("pr-123")).toBe(true);
    expect(isValidHiveHandle("colony:bee.2")).toBe(true);
    expect(isValidHiveHandle("warning:")).toBe(false);
    expect(isValidHiveHandle("two words")).toBe(false);
    expect(isValidHiveHandle("a;b")).toBe(false);
    expect(isValidHiveHandle(undefined)).toBe(false);
  });
});

describe("ActionExecutor honeybee argv execution", () => {
  test("passes webhook-derived strings as single arguments, never through a shell", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
        const marker = join(root, "pwned");
        const message = `PR title with '; touch ${marker}; echo ' and $(touch ${marker}) and \`touch ${marker}\``;
        await executor.executeAction({ kind: "honeybee", run: "send", target: "bee-1", message });

        expect(await pathExists(marker)).toBe(false);
        expect(await hive.log()).toContain(`send bee-1 ${message}`);
      } finally {
        hive.restore();
      }
    });
  });

  test("composes buz argv with sender, tier, subject, and prompt", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
        await executor.executeAction({
          kind: "honeybee",
          run: "buz",
          target: "bee-2",
          message: "hello there",
          tier: "interrupt",
          subject: "ci failed",
        });
        expect(await hive.log()).toContain("buz send bee-2 --sender-human pollinate --tier interrupt --subject ci failed -p hello there");
      } finally {
        hive.restore();
      }
    });
  });

  test("spawn extracts the handle from hive stdout and sends the initial message", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
        const result = await executor.executeAction({
          kind: "honeybee",
          run: "spawn",
          bee: "codex",
          name: "review-1",
          message: "start reviewing",
        });
        expect(result.handle).toBe("review-1");
        const log = await hive.log();
        expect(log).toContain("spawn codex --name review-1");
        expect(log).toContain("send review-1 start reviewing");
      } finally {
        hive.restore();
      }
    });
  });

  test("spawn fails loudly when hive output contains no parsable handle", async () => {
    await withTempStore(async (store, root) => {
      const hiveLog = join(root, "hive.log");
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh\necho "$@" >> "${hiveLog}"\necho "!! totally not a handle !!"\ncat >/dev/null\n`,
      });
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
        await expect(
          executor.executeAction({ kind: "honeybee", run: "spawn", bee: "codex" }),
        ).rejects.toThrow(/did not return a parsable target handle/);
      } finally {
        hive.restore();
      }
    });
  });

  test("spawn falls back to the rendered --name when stdout is unparsable but the name is a valid handle", async () => {
    await withTempStore(async (store, root) => {
      const hiveLog = join(root, "hive.log");
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh\necho "$@" >> "${hiveLog}"\necho "!! noise !!"\ncat >/dev/null\n`,
      });
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
        const result = await executor.executeAction({ kind: "honeybee", run: "spawn", bee: "codex", name: "fallback-1" });
        expect(result.handle).toBe("fallback-1");
      } finally {
        hive.restore();
      }
    });
  });

  test("nonzero hive exits surface the stderr in the error", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh\necho "no such bee" >&2\ncat >/dev/null\nexit 3\n`,
      });
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
        await expect(
          executor.executeAction({ kind: "honeybee", run: "kill", target: "ghost" }),
        ).rejects.toThrow(/hive kill exited 3: no such bee/);
      } finally {
        hive.restore();
      }
    });
  });

  test("sequence actions collect spawn handles and honor primary", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
        const result = await executor.executeAction({
          kind: "sequence",
          mode: "parallel",
          primary: "b",
          actions: [
            { id: "a", action: { kind: "honeybee", run: "spawn", bee: "codex", name: "seq-a" } },
            { id: "b", action: { kind: "honeybee", run: "spawn", bee: "claude", name: "seq-b" } },
          ],
        });
        expect(result.handles).toEqual({ a: "seq-a", b: "seq-b" });
        expect(result.handle).toBe("seq-b");
      } finally {
        hive.restore();
      }
    });
  });
});
