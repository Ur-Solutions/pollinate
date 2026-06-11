import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActionExecutor, DeliveryManager, WebhookServer, githubPrRouterPlugin, routerPluginsDir } from "../src/index.js";
import { installHiveStub, trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

describe("github-pr router plugin", () => {
  test("normalizes pull_request and issue_comment events to the same subject key", () => {
    const opened = githubPrRouterPlugin.normalize({
      headers: { "x-github-event": "pull_request" },
      body: {
        action: "opened",
        repository: { full_name: "trmd/pollinate" },
        sender: { login: "alice" },
        pull_request: { number: 123, html_url: "https://github.com/trmd/pollinate/pull/123", title: "Add router", state: "open", user: { login: "alice" } },
      },
    });
    const comment = githubPrRouterPlugin.normalize({
      headers: { "x-github-event": "issue_comment" },
      body: {
        action: "created",
        repository: { full_name: "trmd/pollinate" },
        sender: { login: "bob" },
        issue: { number: 123, title: "Add router", user: { login: "alice" }, pull_request: { html_url: "https://github.com/trmd/pollinate/pull/123" } },
        comment: { body: "Can you review this?", html_url: "https://github.com/trmd/pollinate/pull/123#issuecomment-1" },
      },
    });

    expect(opened).toHaveLength(1);
    expect(comment).toHaveLength(1);
    expect(opened[0]?.subjectKey).toBe("github:pull_request:trmd/pollinate#123");
    expect(comment[0]?.subjectKey).toBe(opened[0]?.subjectKey);
    expect(opened[0]?.kind).toBe("github.pull_request.opened");
    expect(comment[0]?.kind).toBe("github.issue_comment.created");
    expect(opened[0]?.payload.pr_author).toBe("alice");
    expect(comment[0]?.payload.pr_author).toBe("alice");
  });

  test("ignores comments marked as pollinate router output", () => {
    const events = githubPrRouterPlugin.normalize({
      headers: { "x-github-event": "issue_comment" },
      body: {
        action: "created",
        repository: { full_name: "trmd/pollinate" },
        sender: { login: "alice" },
        issue: { number: 123, title: "Add router", pull_request: { html_url: "https://github.com/trmd/pollinate/pull/123" } },
        comment: {
          body: "<!-- pollinate-router -->\n\nReview complete.",
          html_url: "https://github.com/trmd/pollinate/pull/123#issuecomment-2",
        },
      },
    });

    expect(events).toEqual([]);
  });
});

describe("router bindings", () => {
  test("loads user-space router plugins from the store", async () => {
    await withTempStore(async (store, root) => {
      await writeFile(
        join(routerPluginsDir(root), "custom-pr.mjs"),
        `
export default {
  name: "custom-pr",
  normalize(input) {
    return [{
      subjectKey: "custom:pr#" + input.body.number,
      kind: input.body.kind,
      payload: {
        repo: "custom/repo",
        pr_number: String(input.body.number),
        event_kind: input.body.kind,
        activity_markdown: "custom activity",
      },
    }];
  },
};
`,
      );
      const hive = await installHiveStub(root);
      try {
        const trig = trigger({
          id: "custom-router",
          source: { kind: "webhook", webhook: { path: "custom/pr" } },
          action: undefined,
          router: {
            plugin: "custom-pr",
            openOn: ["custom.open"],
            closeOn: ["custom.closed"],
            onOpen: { kind: "honeybee", run: "spawn", bee: "codex", name: "custom-target" },
            onActivity: { kind: "honeybee", run: "send", target: "{{binding.target}}", message: "{{activity_markdown}}" },
          },
        });
        await store.saveTrigger(trig);
        const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
        await delivery.init([trig]);
        const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
        await server.start();
        try {
          const address = server.address();
          if (!address) throw new Error("server did not bind");
          await fetch(`http://127.0.0.1:${address.port}/hook/custom/pr`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "custom.open", number: 9 }),
          });
          await waitForTerminalJobs(store, 1);
          const binding = await store.getRouterBinding("custom-router", "custom:pr#9");
          expect(binding).toMatchObject({ status: "active", target: { handle: "custom-target" } });
        } finally {
          await server.stop();
          await delivery.shutdown();
        }
      } finally {
        hive.restore();
      }
    });
  });

  test("webhook PR events create, route, and close one addressed hive target", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const trig = trigger({
          id: "github-pr",
          source: { kind: "webhook", webhook: { path: "github/pr" } },
          action: undefined,
          router: {
            plugin: "github-pr",
            openOn: ["github.pull_request.opened", "github.pull_request.reopened"],
            closeOn: ["github.pull_request.merged"],
            onOpen: {
              kind: "honeybee",
              run: "spawn",
              bee: "codex",
              name: "pr-{{repo_slug}}-{{pr_number}}",
              cwd: root,
              yolo: false,
              args: ["--allowedTools", "Read"],
              message: "Review {{repo}}#{{pr_number}}: {{pr_title}}",
            },
            onActivity: {
              kind: "honeybee",
              run: "buz",
              target: "{{binding.target}}",
              tier: "queue",
              subject: "{{event_kind}}",
              message: "{{activity_markdown}}",
            },
            onClose: {
              kind: "honeybee",
              run: "kill",
              target: "{{binding.target}}",
            },
          },
        });
        await store.saveTrigger(trig);
        const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
        await delivery.init([trig]);
        const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
        await server.start();
        try {
          const address = server.address();
          if (!address) throw new Error("server did not bind");
          const url = `http://127.0.0.1:${address.port}/hook/github/pr`;

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "opened",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "alice" },
              pull_request: { number: 123, html_url: "https://github.com/trmd/pollinate/pull/123", title: "Add router", state: "open" },
            }),
          });
          await waitForTerminalJobs(store, 1);
          let binding = await store.getRouterBinding("github-pr", "github:pull_request:trmd/pollinate#123");
          expect(binding).toMatchObject({ status: "active", target: { handle: "pr-trmd-pollinate-123" } });

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "issue_comment" },
            body: JSON.stringify({
              action: "created",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "bob" },
              issue: { number: 123, title: "Add router", pull_request: { html_url: "https://github.com/trmd/pollinate/pull/123" } },
              comment: { body: "Please re-review", html_url: "https://github.com/trmd/pollinate/pull/123#issuecomment-1" },
            }),
          });
          await waitForTerminalJobs(store, 2);

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "closed",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "alice" },
              pull_request: { number: 123, html_url: "https://github.com/trmd/pollinate/pull/123", title: "Add router", state: "closed", merged: true },
            }),
          });
          await waitForTerminalJobs(store, 3);

          binding = await store.getRouterBinding("github-pr", "github:pull_request:trmd/pollinate#123");
          expect(binding?.status).toBe("closed");

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "reopened",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "alice" },
              pull_request: { number: 123, html_url: "https://github.com/trmd/pollinate/pull/123", title: "Add router", state: "open" },
            }),
          });
          await waitForTerminalJobs(store, 4);

          binding = await store.getRouterBinding("github-pr", "github:pull_request:trmd/pollinate#123");
          expect(binding).toMatchObject({ status: "active", target: { handle: "pr-trmd-pollinate-123" } });

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "closed",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "alice" },
              pull_request: { number: 123, html_url: "https://github.com/trmd/pollinate/pull/123", title: "Add router", state: "closed", merged: true },
            }),
          });
          await waitForTerminalJobs(store, 5);

          binding = await store.getRouterBinding("github-pr", "github:pull_request:trmd/pollinate#123");
          expect(binding?.status).toBe("closed");

          const log = await hive.log();
          expect(log).toContain("spawn codex --name pr-trmd-pollinate-123");
          expect(log).toContain("--no-yolo -- --allowedTools Read");
          expect(log.match(/spawn codex/g)).toHaveLength(2);
          expect(log.match(/kill pr-trmd-pollinate-123/g)).toHaveLength(2);
          expect(log).toContain("send pr-trmd-pollinate-123 Review trmd/pollinate#123: Add router");
          expect(log).toContain("buz send pr-trmd-pollinate-123 --sender-human pollinate --tier queue --subject github.issue_comment.created");
          expect(log).toContain("kill pr-trmd-pollinate-123");
        } finally {
          await server.stop();
          await delivery.shutdown();
        }
      } finally {
        hive.restore();
      }
    });
  });

  test("openWhen filters open events that do not match the payload", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const trig = trigger({
          id: "github-pr-mine",
          source: { kind: "webhook", webhook: { path: "github/pr-mine" } },
          action: undefined,
          router: {
            plugin: "github-pr",
            openOn: ["github.pull_request.opened"],
            closeOn: ["github.pull_request.merged"],
            openWhen: { pr_author: "trmdy" },
            onOpen: {
              kind: "honeybee",
              run: "spawn",
              bee: "codex",
              name: "pr-{{pr_number}}",
              message: "Review {{repo}}#{{pr_number}}",
            },
            onActivity: { kind: "honeybee", run: "send", target: "{{binding.target}}", message: "{{activity_markdown}}" },
          },
        });
        await store.saveTrigger(trig);
        const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
        await delivery.init([trig]);
        const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
        await server.start();
        try {
          const address = server.address();
          if (!address) throw new Error("server did not bind");
          const url = `http://127.0.0.1:${address.port}/hook/github/pr-mine`;

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "opened",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "alice" },
              pull_request: { number: 7, html_url: "https://github.com/trmd/pollinate/pull/7", title: "Not mine", state: "open", user: { login: "alice" } },
            }),
          });
          await waitForTerminalJobs(store, 1);
          expect(await store.getRouterBinding("github-pr-mine", "github:pull_request:trmd/pollinate#7")).toBeNull();

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "opened",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "trmdy" },
              pull_request: { number: 8, html_url: "https://github.com/trmd/pollinate/pull/8", title: "Mine", state: "open", user: { login: "trmdy" } },
            }),
          });
          await waitForTerminalJobs(store, 2);
          const binding = await store.getRouterBinding("github-pr-mine", "github:pull_request:trmd/pollinate#8");
          expect(binding).toMatchObject({ status: "active", target: { handle: "pr-8" } });

          const log = await hive.log();
          expect(log).not.toContain("pr-7");
        } finally {
          await server.stop();
          await delivery.shutdown();
        }
      } finally {
        hive.restore();
      }
    });
  });

  test("sequence router actions store and address named swarm targets", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      try {
        const trig = trigger({
          id: "github-pr-swarm",
          source: { kind: "webhook", webhook: { path: "github/pr-swarm" } },
          action: undefined,
          router: {
            plugin: "github-pr",
            openOn: ["github.pull_request.opened"],
            closeOn: ["github.pull_request.merged"],
            onOpen: {
              kind: "sequence",
              mode: "parallel",
              primary: "claude",
              actions: [
                { id: "claude", action: { kind: "honeybee", run: "spawn", bee: "claude", name: "claude-{{pr_number}}" } },
                { id: "grok", action: { kind: "honeybee", run: "spawn", bee: "grok", name: "grok-{{pr_number}}" } },
              ],
            },
            onActivity: {
              kind: "sequence",
              mode: "parallel",
              primary: "claude",
              actions: [
                { id: "claude", action: { kind: "honeybee", run: "send", target: "{{binding.targets.claude}}", message: "claude {{activity_markdown}}" } },
                { id: "grok", action: { kind: "honeybee", run: "send", target: "{{binding.targets.grok}}", message: "grok {{activity_markdown}}" } },
              ],
            },
            onClose: {
              kind: "sequence",
              mode: "parallel",
              continueOnError: true,
              actions: [
                { id: "claude", action: { kind: "honeybee", run: "kill", target: "{{binding.targets.claude}}" } },
                { id: "grok", action: { kind: "honeybee", run: "kill", target: "{{binding.targets.grok}}" } },
              ],
            },
          },
        });
        await store.saveTrigger(trig);
        const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
        await delivery.init([trig]);
        const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
        await server.start();
        try {
          const address = server.address();
          if (!address) throw new Error("server did not bind");
          const url = `http://127.0.0.1:${address.port}/hook/github/pr-swarm`;

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "opened",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "alice" },
              pull_request: { number: 456, html_url: "https://github.com/trmd/pollinate/pull/456", title: "Swarm", state: "open" },
            }),
          });
          await waitForTerminalJobs(store, 1);
          let binding = await store.getRouterBinding("github-pr-swarm", "github:pull_request:trmd/pollinate#456");
          expect(binding?.target).toMatchObject({ handle: "claude-456", handles: { claude: "claude-456", grok: "grok-456" } });

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "issue_comment" },
            body: JSON.stringify({
              action: "created",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "bob" },
              issue: { number: 456, title: "Swarm", pull_request: { html_url: "https://github.com/trmd/pollinate/pull/456" } },
              comment: { body: "Please re-review", html_url: "https://github.com/trmd/pollinate/pull/456#issuecomment-1" },
            }),
          });
          await waitForTerminalJobs(store, 2);

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "closed",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "alice" },
              pull_request: { number: 456, html_url: "https://github.com/trmd/pollinate/pull/456", title: "Swarm", state: "closed", merged: true },
            }),
          });
          await waitForTerminalJobs(store, 3);

          binding = await store.getRouterBinding("github-pr-swarm", "github:pull_request:trmd/pollinate#456");
          expect(binding?.status).toBe("closed");
          const log = await hive.log();
          expect(log).toContain("spawn claude --name claude-456");
          expect(log).toContain("spawn grok --name grok-456");
          expect(log).toContain("send claude-456");
          expect(log).toContain("send grok-456");
          expect(log).toContain("kill claude-456");
          expect(log).toContain("kill grok-456");
        } finally {
          await server.stop();
          await delivery.shutdown();
        }
      } finally {
        hive.restore();
      }
    });
  });

  test("activity delivery failures record the error on the binding", async () => {
    await withTempStore(async (store, root) => {
      const hiveLog = join(root, "hive.log");
      const hive = await installHiveStub(root, {
        script: `#!/bin/sh
echo "$@" >> "${hiveLog}"
if [ "$1" = "spawn" ]; then
  printf 'pr-77\\tcodex\\t/tmp\\tlocal\\n'
fi
if [ "$1" = "send" ]; then
  echo "session gone" >&2
  cat >/dev/null
  exit 1
fi
cat >/dev/null
`,
      });
      try {
        const trig = trigger({
          id: "github-pr-err",
          source: { kind: "webhook", webhook: { path: "github/pr-err" } },
          action: undefined,
          router: {
            plugin: "github-pr",
            openOn: ["github.pull_request.opened"],
            closeOn: ["github.pull_request.merged"],
            onOpen: { kind: "honeybee", run: "spawn", bee: "codex", name: "pr-{{pr_number}}" },
            onActivity: { kind: "honeybee", run: "send", target: "{{binding.target}}", message: "{{activity_markdown}}" },
          },
        });
        await store.saveTrigger(trig);
        const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
        await delivery.init([trig]);
        const server = new WebhookServer(store, delivery, [trig], "127.0.0.1", 0);
        await server.start();
        try {
          const address = server.address();
          if (!address) throw new Error("server did not bind");
          const url = `http://127.0.0.1:${address.port}/hook/github/pr-err`;

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "pull_request" },
            body: JSON.stringify({
              action: "opened",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "alice" },
              pull_request: { number: 77, html_url: "https://github.com/trmd/pollinate/pull/77", title: "Errs", state: "open" },
            }),
          });
          await waitForTerminalJobs(store, 1);

          await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-github-event": "issue_comment" },
            body: JSON.stringify({
              action: "created",
              repository: { full_name: "trmd/pollinate" },
              sender: { login: "bob" },
              issue: { number: 77, title: "Errs", pull_request: { html_url: "https://github.com/trmd/pollinate/pull/77" } },
              comment: { body: "ping", html_url: "https://github.com/trmd/pollinate/pull/77#issuecomment-1" },
            }),
          });
          await waitForTerminalJobs(store, 2);

          const binding = await store.getRouterBinding("github-pr-err", "github:pull_request:trmd/pollinate#77");
          expect(binding?.status).toBe("active");
          expect(binding?.error).toContain("hive send exited 1");
          const ledger = (await store.readLedger()).join("\n");
          expect(ledger).toContain("pollinate.router.activity_errored");
        } finally {
          await server.stop();
          await delivery.shutdown();
        }
      } finally {
        hive.restore();
      }
    });
  });
});
