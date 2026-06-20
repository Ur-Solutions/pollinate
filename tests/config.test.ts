import { describe, expect, test } from "vitest";
import { DEFAULT_DAEMON_CONFIG, parseDaemonConfigToml, parseTriggerToml, slugify, triggerToToml } from "../src/config.js";
import { trigger } from "./helpers.js";

describe("parseTriggerToml", () => {
  test("parses a minimal command trigger with defaults", () => {
    const parsed = parseTriggerToml(
      `[trigger]
name = "Hourly Echo"

[trigger.source]
kind = "manual"

[trigger.delivery]
mode = "immediate"

[trigger.action]
kind = "command"
command = "echo hi"
`,
      "hourly-echo",
    );

    expect(parsed.id).toBe("hourly-echo");
    expect(parsed.name).toBe("Hourly Echo");
    expect(parsed.enabled).toBe(true);
    expect(parsed.tags).toEqual([]);
    expect(parsed.source).toEqual({ kind: "manual" });
    expect(parsed.delivery).toEqual({ mode: { strategy: "immediate" }, maxConcurrent: 1 });
    expect(parsed.action).toEqual({ kind: "command", command: "echo hi", cwd: undefined, timeout: undefined });
  });

  test("parses a full router config including snake_case aliases", () => {
    const parsed = parseTriggerToml(
      `[trigger]
id = "pr-review"

[trigger.source]
kind = "webhook"

[trigger.source.webhook]
path = "/github/pr"

[trigger.delivery]
mode = "immediate"
max_concurrent = 4

[trigger.router]
plugin = "github-pr"
open_on = ["github.pull_request.opened"]
close_on = ["github.pull_request.merged"]
idle_ttl = "48h"

[trigger.router.open_when]
pr_author = "trmdy"

[trigger.router.activity_when]
event_kind = "github.pull_request.synchronize"

[trigger.router.on_open]
kind = "honeybee"
run = "spawn"
bee = "codex"
account = "auto"
name = "pr-{{pr_number}}"

[trigger.router.on_activity]
kind = "honeybee"
run = "send"
target = "{{binding.target}}"
message = "{{activity_markdown}}"
`,
      "pr-review",
    );

    expect(parsed.source).toMatchObject({ kind: "webhook", webhook: { path: "github/pr" } });
    expect(parsed.delivery.maxConcurrent).toBe(4);
    expect(parsed.router).toMatchObject({
      plugin: "github-pr",
      openOn: ["github.pull_request.opened"],
      closeOn: ["github.pull_request.merged"],
      openWhen: { pr_author: "trmdy" },
      activityWhen: { event_kind: "github.pull_request.synchronize" },
      idleTtl: "48h",
      onOpen: { kind: "honeybee", run: "spawn", bee: "codex", account: "auto", name: "pr-{{pr_number}}" },
      onActivity: { kind: "honeybee", run: "send", target: "{{binding.target}}" },
    });
    expect(parsed.router?.onClose).toBeUndefined();
    expect(parsed.action).toBeUndefined();
  });

  test("round-trips a router trigger through TOML", () => {
    const original = trigger({
      id: "round-trip",
      action: undefined,
      filter: { status: "done", agent: true },
      source: { kind: "webhook", webhook: { path: "rt/pr", secret: "env:HOOK_SECRET" } },
      router: {
        plugin: "github-pr",
        openOn: ["github.pull_request.opened"],
        closeOn: ["github.pull_request.merged"],
        openWhen: { pr_author: "trmdy" },
        idleTtl: "2d",
        onOpen: { kind: "honeybee", run: "spawn", bee: "codex", name: "pr-{{pr_number}}" },
        onActivity: { kind: "honeybee", run: "send", target: "{{binding.target}}", message: "{{activity_markdown}}" },
        onClose: { kind: "honeybee", run: "kill", target: "{{binding.target}}" },
      },
    });

    const reparsed = parseTriggerToml(triggerToToml(original), original.id);

    expect(reparsed.router).toMatchObject(original.router!);
    expect(reparsed.filter).toEqual(original.filter);
    expect(reparsed.source).toMatchObject(original.source);
  });

  test("rejects triggers without an action or router", () => {
    expect(() =>
      parseTriggerToml(
        `[trigger]
id = "broken"

[trigger.source]
kind = "manual"

[trigger.delivery]
mode = "immediate"
`,
      ),
    ).toThrow(/requires either/);
  });

  test("rejects unknown source kinds, delivery modes, and honeybee run modes", () => {
    const base = (source: string, delivery: string, action: string) => `[trigger]
id = "x"

[trigger.source]
${source}

[trigger.delivery]
${delivery}

[trigger.action]
${action}
`;
    const ok = { source: 'kind = "manual"', delivery: 'mode = "immediate"', action: 'kind = "command"\ncommand = "true"' };
    expect(() => parseTriggerToml(base('kind = "carrier-pigeon"', ok.delivery, ok.action))).toThrow(/Unsupported source kind/);
    expect(() => parseTriggerToml(base(ok.source, 'mode = "psychic"', ok.action))).toThrow(/Unsupported delivery mode/);
    expect(() => parseTriggerToml(base(ok.source, ok.delivery, 'kind = "honeybee"\nrun = "dance"'))).toThrow(/Unsupported honeybee run mode/);
  });

  test("rejects routers missing event lists or actions", () => {
    const toml = (routerBody: string) => `[trigger]
id = "r"

[trigger.source]
kind = "manual"

[trigger.delivery]
mode = "immediate"

[trigger.router]
${routerBody}
`;
    expect(() => parseTriggerToml(toml('plugin = "github-pr"\nopenOn = []\ncloseOn = ["x"]'))).toThrow(/openOn/);
    expect(() =>
      parseTriggerToml(toml('plugin = "github-pr"\nopenOn = ["a"]\ncloseOn = ["b"]')),
    ).toThrow(/onOpen/);
  });

  test("validates durations in schedules and delivery windows", () => {
    expect(() =>
      parseTriggerToml(
        `[trigger]
id = "bad-interval"

[trigger.source]
kind = "schedule"

[trigger.source.timing]
type = "every"
interval = "sometimes"

[trigger.delivery]
mode = "immediate"

[trigger.action]
kind = "command"
command = "true"
`,
      ),
    ).toThrow(/Invalid duration/);
  });
});

describe("parseDaemonConfigToml", () => {
  test("returns defaults for empty or missing config", () => {
    expect(parseDaemonConfigToml(null)).toEqual(DEFAULT_DAEMON_CONFIG);
    expect(parseDaemonConfigToml("")).toEqual(DEFAULT_DAEMON_CONFIG);
    expect(DEFAULT_DAEMON_CONFIG.defaults.bindingGcMs).toBe(60_000);
  });

  test("parses overrides including the binding GC interval", () => {
    const config = parseDaemonConfigToml(`[webhook]
bind = "0.0.0.0"
port = 4000
public_url = "https://hooks.example.com"

[defaults]
binding_gc_ms = 30000
trigger_reload_ms = 2000
job_gc_ms = 120000
job_retention = "3d"
max_jobs = 500

[execution]
shell = "/bin/zsh"
shell_args = ["-lc"]
`);

    expect(config.webhook).toMatchObject({ bind: "0.0.0.0", port: 4000, publicUrl: "https://hooks.example.com" });
    expect(config.defaults.bindingGcMs).toBe(30_000);
    expect(config.defaults.triggerReloadMs).toBe(2_000);
    expect(config.defaults.jobGcMs).toBe(120_000);
    expect(config.defaults.jobRetention).toBe("3d");
    expect(config.defaults.maxJobs).toBe(500);
    expect(config.execution).toMatchObject({ shell: "/bin/zsh", shellArgs: ["-lc"] });
  });
});

describe("slugify", () => {
  test("lowercases and strips unsafe characters", () => {
    expect(slugify("My PR Router!")).toBe("my-pr-router");
    expect(slugify("  ")).toBe("trigger");
  });
});
