import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActionExecutor, DeliveryManager, WebhookServer, githubPrRouterPlugin } from "../src/index.js";
import { trigger, waitForTerminalJobs, withTempStore } from "./helpers.js";

describe("github-pr router plugin", () => {
  test("normalizes pull_request and issue_comment events to the same subject key", () => {
    const opened = githubPrRouterPlugin.normalize({
      headers: { "x-github-event": "pull_request" },
      body: {
        action: "opened",
        repository: { full_name: "trmd/pollinate" },
        sender: { login: "alice" },
        pull_request: { number: 123, html_url: "https://github.com/trmd/pollinate/pull/123", title: "Add router", state: "open" },
      },
    });
    const comment = githubPrRouterPlugin.normalize({
      headers: { "x-github-event": "issue_comment" },
      body: {
        action: "created",
        repository: { full_name: "trmd/pollinate" },
        sender: { login: "bob" },
        issue: { number: 123, title: "Add router", pull_request: { html_url: "https://github.com/trmd/pollinate/pull/123" } },
        comment: { body: "Can you review this?", html_url: "https://github.com/trmd/pollinate/pull/123#issuecomment-1" },
      },
    });

    expect(opened).toHaveLength(1);
    expect(comment).toHaveLength(1);
    expect(opened[0]?.subjectKey).toBe("github:pull_request:trmd/pollinate#123");
    expect(comment[0]?.subjectKey).toBe(opened[0]?.subjectKey);
    expect(opened[0]?.kind).toBe("github.pull_request.opened");
    expect(comment[0]?.kind).toBe("github.issue_comment.created");
  });
});

describe("router bindings", () => {
  test("webhook PR events create, route, and close one addressed hive target", async () => {
    await withTempStore(async (store, root) => {
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      const hiveLog = join(root, "hive.log");
      await writeFile(
        join(bin, "hive"),
        `#!/bin/sh
echo "$@" >> "${hiveLog}"
if [ "$1" = "spawn" ]; then
  name="spawned"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--name" ]; then
      shift
      name="$1"
    fi
    shift
  done
  printf '%s\\tcodex\\t/tmp\\tlocal\\n' "$name"
fi
cat >/dev/null
`,
      );
      await chmod(join(bin, "hive"), 0o700);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}:${previousPath ?? ""}`;
      try {
        const trig = trigger({
          id: "github-pr",
          source: { kind: "webhook", webhook: { path: "github/pr" } },
          action: undefined,
          router: {
            plugin: "github-pr",
            openOn: ["github.pull_request.opened"],
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
          const log = await readFile(hiveLog, "utf8");
          expect(log).toContain("spawn codex --name pr-trmd-pollinate-123");
          expect(log).toContain("--no-yolo -- --allowedTools Read");
          expect(log).toContain("send pr-trmd-pollinate-123 Review trmd/pollinate#123: Add router");
          expect(log).toContain("buz send pr-trmd-pollinate-123 --sender-human pollinate --tier queue --subject github.issue_comment.created");
          expect(log).toContain("kill pr-trmd-pollinate-123");
        } finally {
          await server.stop();
          await delivery.shutdown();
        }
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    });
  });
});
