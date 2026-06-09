import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { withTempStore } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("CLI", () => {
  test("satellite run starts without a writable pollinate store", async () => {
    const cli = join(process.cwd(), "dist", "cli.js");
    const child = spawn(
      process.execPath,
      [
        cli,
        "satellite",
        "run",
        "--bind",
        "127.0.0.1",
        "--port",
        "0",
        "--target",
        "http://127.0.0.1:1",
        "--secret",
        "test",
      ],
      { env: { ...process.env, HOME: "/", POLLINATE_STORE_ROOT: "" } },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for satellite start")), 2_000);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (chunk.includes("satellite listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`satellite exited ${code}`));
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } finally {
      child.kill("SIGTERM");
    }
  });

  test("create registers a trigger entirely from CLI flags", async () => {
    await withTempStore(async (_store, root) => {
      const out = join(root, "created.txt");
      const env = { ...process.env, POLLINATE_STORE_ROOT: root };
      const cli = join(process.cwd(), "dist", "cli.js");
      const created = await execFileAsync(
        process.execPath,
        [
          cli,
          "create",
          "cli-created",
          "--source",
          "manual",
          "--delivery",
          "immediate",
          "--max-concurrent",
          "1",
          "--action",
          "command",
          "--cwd",
          root,
          "--command",
          `node -e "require('fs').writeFileSync('${out}', 'from {{name}}')"`,
          "--timeout",
          "1s",
          "--static",
          "name=cli",
          "--tag",
          "smoke",
          "--json",
        ],
        { env },
      );
      const trigger = JSON.parse(created.stdout);
      expect(trigger.id).toBe("cli-created");
      expect(trigger.cwd).toBe(root);
      expect(trigger.source.kind).toBe("manual");
      expect(trigger.action.kind).toBe("command");
      expect(trigger.action.cwd).toBeUndefined();
      expect(trigger.context.static.name).toBe("cli");

      const fired = await execFileAsync(process.execPath, [cli, "trigger", "cli-created", "--json"], { env });
      const job = JSON.parse(fired.stdout);
      expect(job.status).toBe("completed");
      expect(job.cwd).toBe(root);
      expect(await import("node:fs/promises").then((fs) => fs.readFile(out, "utf8"))).toBe("from cli");
    });
  });

  test("create keeps --once <iso> as a schedule timestamp", async () => {
    await withTempStore(async (_store, root) => {
      const env = { ...process.env, POLLINATE_STORE_ROOT: root };
      const cli = join(process.cwd(), "dist", "cli.js");
      const at = "2026-06-09T10:00:00.000Z";
      const created = await execFileAsync(
        process.execPath,
        [
          cli,
          "create",
          "once-schedule",
          "--source",
          "schedule",
          "--once",
          at,
          "--action",
          "emit",
          "--subject",
          "schedule.once",
          "--json",
        ],
        { env },
      );
      const trigger = JSON.parse(created.stdout);
      expect(trigger.source).toMatchObject({ kind: "schedule", timing: { type: "once", at } });
    });
  });

  test("create supports JSON escape hatches for complex trigger parts", async () => {
    await withTempStore(async (_store, root) => {
      const env = { ...process.env, POLLINATE_STORE_ROOT: root };
      const cli = join(process.cwd(), "dist", "cli.js");
      const created = await execFileAsync(
        process.execPath,
        [
          cli,
          "create",
          "json-webhook",
          "--source-json",
          '{"kind":"webhook","webhook":{"path":"fanout","transform":{"text":"$.message.text"}}}',
          "--delivery-json",
          '{"mode":{"strategy":"debounced","quietPeriod":"10s"},"maxConcurrent":2}',
          "--action-json",
          '{"kind":"emit","subject":"message.received","payload":"{\\"text\\":\\"{{text}}\\"}"}',
          "--filter-json",
          '{"text":true}',
          "--json",
        ],
        { env },
      );
      const trigger = JSON.parse(created.stdout);
      expect(trigger.source.webhook.path).toBe("fanout");
      expect(trigger.delivery.mode.strategy).toBe("debounced");
      expect(trigger.action.subject).toBe("message.received");
      expect(trigger.filter.text).toBe(true);
    });
  });

  test("routers init scaffolds a user-space router plugin", async () => {
    await withTempStore(async (_store, root) => {
      const env = { ...process.env, POLLINATE_STORE_ROOT: root };
      const cli = join(process.cwd(), "dist", "cli.js");
      const created = await execFileAsync(process.execPath, [cli, "routers", "init", "linear-review", "--json"], { env });
      const result = JSON.parse(created.stdout);
      expect(result.path).toBe(join(root, "router-plugins", "linear-review.mjs"));
      expect(await import("node:fs/promises").then((fs) => fs.readFile(result.path, "utf8"))).toContain('name: "linear-review"');

      const listed = await execFileAsync(process.execPath, [cli, "routers", "list", "--json"], { env });
      expect(JSON.parse(listed.stdout)).toContain("linear-review");
    });
  });

  test("github create-pr-router can generate a dry-run swarm trigger", async () => {
    await withTempStore(async (_store, root) => {
      const env = { ...process.env, POLLINATE_STORE_ROOT: root };
      const cli = join(process.cwd(), "dist", "cli.js");
      const created = await execFileAsync(
        process.execPath,
        [
          cli,
          "github",
          "create-pr-router",
          "pollinate-pr-router",
          "--repo",
          "trmd/pollinate",
          "--cwd",
          root,
          "--reviewer",
          "claude=claude",
          "--reviewer",
          "grok=grok",
          "--dry-run",
          "--json",
        ],
        { env },
      );
      const result = JSON.parse(created.stdout);
      expect(result.trigger.router.plugin).toBe("github-pr");
      expect(result.trigger.router.onOpen).toMatchObject({ kind: "sequence", mode: "parallel", primary: "claude" });
      expect(result.trigger.router.onActivity.actions[1].action.target).toBe("{{binding.targets.grok}}");
    });
  });

  test("hook create builds a temporary one-shot webhook with an unguessable URL", async () => {
    await withTempStore(async (store, root) => {
      const env = { ...process.env, POLLINATE_STORE_ROOT: root };
      const cli = join(process.cwd(), "dist", "cli.js");
      const created = await execFileAsync(
        process.execPath,
        [
          cli,
          "hook",
          "create",
          "callback",
          "--ttl",
          "10m",
          "--once",
          "--base-url",
          "https://hooks.trmd.me",
          "--action",
          "emit",
          "--subject",
          "callback.received",
          "--json",
        ],
        { env },
      );

      const result = JSON.parse(created.stdout);
      expect(result.id).toBe("callback");
      expect(result.url).toMatch(/^https:\/\/hooks\.trmd\.me\/hook\/tmp\/[a-z0-9_-]{24,}$/);
      expect(result.expiresAt).toBeTruthy();
      expect(result.maxDeliveries).toBe(1);

      const trigger = await store.requireTrigger("callback");
      expect(trigger.source.kind).toBe("webhook");
      expect(trigger.source.kind === "webhook" ? trigger.source.webhook.path : "").toBe(result.path);
      expect(trigger.lifecycle).toMatchObject({ temporary: true, maxDeliveries: 1, deliveries: 0 });
    });
  });

  test("hook gc removes expired temporary hooks", async () => {
    await withTempStore(async (store, root) => {
      const expired = {
        id: "expired-temp",
        name: "expired-temp",
        tags: [],
        enabled: true,
        source: { kind: "webhook" as const, webhook: { path: "tmp/expired" } },
        delivery: { mode: { strategy: "immediate" as const }, maxConcurrent: 1 },
        lifecycle: { temporary: true, expiresAt: new Date(Date.now() - 1_000).toISOString(), deliveries: 0 },
        action: { kind: "emit" as const, subject: "expired" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.saveTrigger(expired);
      const env = { ...process.env, POLLINATE_STORE_ROOT: root };
      const cli = join(process.cwd(), "dist", "cli.js");

      const removed = await execFileAsync(process.execPath, [cli, "hook", "gc", "--json"], { env });
      expect(JSON.parse(removed.stdout).removed).toEqual(["expired-temp"]);
      expect(await store.getTrigger("expired-temp")).toBeNull();
    });
  });

  test("add/list/get/trigger/jobs/status/ledger work with --json", async () => {
    await withTempStore(async (_store, root) => {
      const config = join(root, "hello.toml");
      const out = join(root, "out.txt");
      await writeFile(
        config,
        `
[trigger]
name = "hello"
enabled = true

[trigger.source]
kind = "manual"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 1

[trigger.context.static]
name = "world"

[trigger.action]
kind = "command"
command = "node -e \\"require('fs').writeFileSync('${out}', 'hi {{name}}')\\""
timeout = "1s"
`,
      );
      const env = { ...process.env, POLLINATE_STORE_ROOT: root };
      const cli = join(process.cwd(), "dist", "cli.js");
      const add = await execFileAsync(process.execPath, [cli, "add", config, "--json"], { env });
      expect(JSON.parse(add.stdout).id).toBe("hello");

      const list = await execFileAsync(process.execPath, [cli, "list", "--json"], { env });
      expect(JSON.parse(list.stdout)).toHaveLength(1);

      const ls = await execFileAsync(process.execPath, [cli, "ls", "--json"], { env });
      expect(ls.stdout).toBe(list.stdout);

      const dry = await execFileAsync(process.execPath, [cli, "trigger", "hello", "--dry-run", "--json"], { env });
      expect(JSON.parse(dry.stdout).action.command).toContain("hi world");

      const fired = await execFileAsync(process.execPath, [cli, "trigger", "hello", "--json"], { env });
      expect(JSON.parse(fired.stdout).status).toBe("completed");

      const jobs = await execFileAsync(process.execPath, [cli, "jobs", "--json"], { env });
      expect(JSON.parse(jobs.stdout)[0].triggerId).toBe("hello");

      const status = await execFileAsync(process.execPath, [cli, "status", "--json"], { env });
      expect(JSON.parse(status.stdout).triggers.enabled).toBe(1);

      const ledger = await execFileAsync(process.execPath, [cli, "ledger", "-n", "5", "--json"], { env });
      expect(JSON.parse(ledger.stdout).some((line: string) => line.includes("pollinate.job.completed"))).toBe(true);
    });
  });
});
