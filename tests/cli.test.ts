import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { withTempStore } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("CLI", () => {
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
