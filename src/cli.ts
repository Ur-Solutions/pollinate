#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PollinateStore } from "./store.js";
import { ActionExecutor } from "./actions.js";
import { parseDuration, sleep, nowIso } from "./time.js";
import { slugify } from "./config.js";
import { applyWebhookTransform } from "./webhook.js";
import { runForeground } from "./daemon.js";
import { SatelliteServer } from "./satellite.js";
import { createWebhookHook, gcTemporaryHooks, randomHookToken, type HookCreateResult } from "./hooks.js";
import { atomicWriteFile, pathExists, routerPluginsDir } from "./fsx.js";
import { listRouterPlugins, routerPluginTemplate } from "./router-plugins/index.js";
import { GITHUB_PR_ROUTER_EVENTS, installGithubWebhook } from "./providers/github.js";
import { resolveSecret } from "./secrets.js";
import {
  daemonLogs,
  daemonStatus,
  installDaemon,
  restartDaemon,
  startDaemon,
  stopDaemon,
  uninstallDaemon,
} from "./service.js";
import {
  banner,
  box,
  c,
  field,
  fields,
  formatDuration,
  heading,
  jobBadge,
  pad,
  relativeTime,
  say,
  sourceLabel,
  spinner,
  statusDot,
  sym,
  table,
  truncate,
} from "./ui.js";
import type { Action, Activation, ContextResolver, Delivery, Filter, Job, JobStatus, JsonValue, MissedFirePolicy, RouterConfig, Source, SourceKind, Trigger } from "./types.js";

type ParsedArgs = {
  command?: string;
  rest: string[];
  flags: Record<string, string | boolean | string[]>;
  json: boolean;
};

const TERMINAL = new Set<JobStatus>(["completed", "errored", "timed-out", "cancelled"]);

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  let store: PollinateStore | undefined;
  const getStore = async () => {
    store ??= new PollinateStore();
    await store.ensure();
    return store;
  };
  switch (args.command) {
    case "add":
      await cmdAdd(await getStore(), args);
      return;
    case "create":
      await cmdCreate(await getStore(), args);
      return;
    case "list":
    case "ls":
      await cmdList(await getStore(), args);
      return;
    case "get":
      await cmdGet(await getStore(), args);
      return;
    case "enable":
      await cmdEnable(await getStore(), args, true);
      return;
    case "disable":
      await cmdEnable(await getStore(), args, false);
      return;
    case "remove":
      await cmdRemove(await getStore(), args);
      return;
    case "edit":
      await cmdEdit(await getStore(), args);
      return;
    case "trigger":
      await cmdTrigger(await getStore(), args);
      return;
    case "jobs":
      await cmdJobs(await getStore(), args);
      return;
    case "bindings":
      await cmdBindings(await getStore(), args);
      return;
    case "routers":
      await cmdRouters(await getStore(), args);
      return;
    case "job":
      await cmdJob(await getStore(), args);
      return;
    case "hooks":
      await cmdHooks(await getStore(), args);
      return;
    case "hook":
      await cmdHook(await getStore(), args);
      return;
    case "daemon":
      await cmdDaemon(args);
      return;
    case "satellite":
      await cmdSatellite(args);
      return;
    case "github":
      await cmdGithub(await getStore(), args);
      return;
    case "status":
      await cmdStatus(await getStore(), args);
      return;
    case "ledger":
      await cmdLedger(await getStore(), args);
      return;
    case "help":
    case undefined:
      await printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

async function cmdAdd(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const file = requiredArg(args.rest[0], "Usage: pollinate add <config.toml>");
  const text = await readFile(file, "utf8");
  const trigger = await store.addTriggerFromToml(text);
  print(args, trigger, `${say.ok(`added ${c.bold(trigger.id)}`)}  ${c.dim(triggerSummary(trigger))}`);
}

async function cmdCreate(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const id = slugify(requiredArg(args.rest[0], "Usage: pollinate create <id> --source <kind> --action <kind> [flags]"));
  const now = nowIso();
  const router = routerFromFlags(args);
  const action = actionFromFlagsOptional(args);
  if (!router && !action) throw new Error("Create requires --action <kind>, --action-json, or --router-json");
  const trigger: Trigger = {
    id,
    name: stringFlag(args, "name") ?? id,
    description: stringFlag(args, "description"),
    cwd: stringFlag(args, "cwd"),
    tags: flagValues(args, "tag"),
    enabled: args.flags.disabled ? false : true,
    source: sourceFromFlags(args),
    filter: filterFromFlags(args),
    delivery: deliveryFromFlags(args),
    context: contextFromFlags(args),
    router,
    action,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveTrigger(trigger);
  await store.appendLedger({ event: "pollinate.trigger.added", trigger_id: trigger.id, via: "cli-create" });
  const human = [
    `${say.ok(`created ${c.bold(trigger.id)}`)}  ${c.dim(triggerSummary(trigger))}`,
    `  ${say.hint(`inspect with ${c.bold(`pol get ${trigger.id}`)}, fire with ${c.bold(`pol trigger ${trigger.id}`)}`)}`,
  ].join("\n");
  print(args, trigger, human);
}

async function cmdList(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const triggers = (await store.loadTriggers()).filter((trigger) => {
    if (args.flags.enabled && !trigger.enabled) return false;
    if (args.flags.disabled && trigger.enabled) return false;
    const tag = stringFlag(args, "tag");
    if (tag && !trigger.tags.includes(tag)) return false;
    const source = stringFlag(args, "source");
    if (source && trigger.source.kind !== source) return false;
    return true;
  });
  print(args, triggers, renderTriggerList(triggers));
}

function renderTriggerList(triggers: Trigger[]): string {
  if (!triggers.length) {
    return [
      c.dim("No triggers yet."),
      say.hint(`create one with ${c.bold("pol create <id> --source schedule --every 1h --action command --command '…'")}`),
    ].join("\n");
  }
  const enabled = triggers.filter((t) => t.enabled).length;
  const head = `${c.bold(String(triggers.length))} ${plural(triggers.length, "trigger")}  ${c.dim(`${enabled} enabled · ${triggers.length - enabled} disabled`)}`;
  const rows = triggers.map((trigger) => [
    statusDot(trigger.enabled),
    c.bold(trigger.id),
    sourceLabel(trigger.source.kind),
    c.dim(sourceDetail(trigger.source)),
    trigger.tags.length ? c.gray(trigger.tags.join(" ")) : "",
  ]);
  return `${head}\n\n${table(rows, { head: ["", "id", "source", "detail", "tags"] })}`;
}

async function cmdGet(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const trigger = await store.requireTrigger(requiredArg(args.rest[0], "Usage: pollinate get <id>"));
  print(args, trigger, renderTrigger(trigger));
}

async function cmdEnable(store: PollinateStore, args: ParsedArgs, enabled: boolean): Promise<void> {
  const trigger = await store.setTriggerEnabled(requiredArg(args.rest[0], `Usage: pollinate ${enabled ? "enable" : "disable"} <id>`), enabled);
  const verb = enabled ? c.green("enabled") : c.yellow("disabled");
  print(args, trigger, `${statusDot(enabled)} ${verb} ${c.bold(trigger.id)}`);
}

async function cmdRemove(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const id = requiredArg(args.rest[0], "Usage: pollinate remove <id>");
  await store.removeTrigger(id);
  print(args, { removed: id }, say.ok(`removed ${c.bold(id)}`));
}

async function cmdEdit(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const id = requiredArg(args.rest[0], "Usage: pollinate edit <id>");
  await store.requireTrigger(id);
  const editor = process.env.EDITOR || "vi";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [store.triggerPath(id)], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${editor} exited ${code}`))));
  });
}

async function cmdTrigger(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const id = requiredArg(args.rest[0], "Usage: pollinate trigger <id> [--payload '{...}'] [--dry-run]");
  const trigger = await store.requireTrigger(id);
  const payload = parsePayload(stringFlag(args, "payload") ?? "{}");
  const activation: Activation = { triggerId: trigger.id, source: "manual", payload, receivedAt: nowIso() };
  const executor = await newExecutor(store);
  if (args.flags["dry-run"]) {
    const dryRun = await executor.dryRun(trigger, activation, [payload]);
    print(args, dryRun, renderDryRun(trigger, dryRun));
    return;
  }
  const job = await executor.createQueuedJob(trigger, activation, [payload]);
  await store.saveJob(job);
  await store.appendLedger({ event: "pollinate.job.queued", job_id: job.id, trigger_id: trigger.id, queue_position: 0, at: nowIso() });
  const completed = await runWithSpinner(args, `firing ${c.bold(trigger.id)}…`, () =>
    executor.executeJob(job, trigger, activation, [payload]),
  );
  print(args, completed, renderJobOutcome(completed));
}

type DryRunResult = Awaited<ReturnType<ActionExecutor["dryRun"]>>;

function renderDryRun(trigger: Trigger, dryRun: DryRunResult): string {
  const lines = [
    `${c.accent(sym.flower)} ${c.bold("dry run")} ${c.dim(sym.mid)} ${c.bold(trigger.id)}`,
    "",
    fields([
      ["context", describeContext(dryRun.context)],
      dryRun.action ? ["action", describeAction(dryRun.action)] : ["action", c.dim("none")],
    ]),
  ];
  const detail = dryRun.action ? actionDetail(dryRun.action) : undefined;
  if (detail) lines.push(field("", c.dim(detail), "context".length));
  if (dryRun.warnings.length) {
    lines.push("");
    lines.push(c.dim("warnings"));
    for (const w of dryRun.warnings) lines.push(`  ${say.warn(w)}`);
  } else {
    lines.push("");
    lines.push(say.ok(c.dim("no warnings — ready to fire")));
  }
  return lines.join("\n");
}

function renderJobOutcome(job: Job): string {
  const head = `${jobBadge(job.status)}  ${c.dim("job")} ${c.bold(shortId(job.id))}`;
  const took = jobDuration(job);
  const meta = took ? c.dim(`took ${formatDuration(took)}`) : "";
  const line = meta ? `${head}  ${meta}` : head;
  if (job.error) return `${line}\n  ${say.fail(c.red(job.error))}`;
  return line;
}

async function cmdJobs(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const status = stringFlag(args, "status") as JobStatus | undefined;
  const triggerId = stringFlag(args, "trigger");
  const last = numberFlag(args, "last");
  const jobs = await store.listJobs({ status, triggerId, last });
  print(args, jobs, renderJobList(jobs));
}

async function cmdBindings(store: PollinateStore, args: ParsedArgs): Promise<void> {
  if (args.rest[0] === "get") {
    const id = requiredArg(args.rest[1], "Usage: pollinate bindings get <bindingId>");
    const bindings = await store.listRouterBindings();
    const binding = bindings.find((item) => item.id === id);
    if (!binding) throw new Error(`No router binding found with id "${id}"`);
    print(args, binding, renderBinding(binding));
    return;
  }
  const bindings = await store.listRouterBindings({ triggerId: stringFlag(args, "trigger") });
  print(args, bindings, renderBindingList(bindings));
}

async function cmdRouters(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const sub = args.rest[0] ?? "list";
  if (sub === "list") {
    const plugins = await listRouterPlugins({ root: store.root });
    print(args, plugins, renderRouterPluginList(plugins));
    return;
  }
  if (sub === "init") {
    const name = slugify(requiredArg(args.rest[1], "Usage: pollinate routers init <name> [--force]"));
    const path = join(routerPluginsDir(store.root), `${name}.mjs`);
    if ((await pathExists(path)) && !args.flags.force) throw new Error(`Router plugin already exists: ${path}`);
    await atomicWriteFile(path, routerPluginTemplate(name), { mode: 0o600 });
    await store.appendLedger({ event: "pollinate.router.plugin.created", plugin: name, path });
    print(args, { name, path }, `${say.ok(`created router plugin ${c.bold(name)}`)}\n  ${c.dim(path)}`);
    return;
  }
  throw new Error("Usage: pollinate routers [list] | routers init <name>");
}

function renderRouterPluginList(plugins: string[]): string {
  if (!plugins.length) return c.dim("No router plugins found.");
  return table(plugins.map((plugin) => [c.bold(plugin)]), { head: ["router"] });
}

type BindingRow = Awaited<ReturnType<PollinateStore["listRouterBindings"]>>[number];

function renderBindingList(bindings: BindingRow[]): string {
  if (!bindings.length) return c.dim("No router bindings yet.");
  const rows = bindings.map((binding) => [
    bindingStatus(binding.status),
    c.dim(binding.id),
    c.bold(binding.triggerId),
    c.cyan(binding.subjectKey),
    binding.target?.handle ?? c.dim("-"),
    relativeTime(binding.lastActivityAt ?? binding.updatedAt),
  ]);
  return table(rows, { head: ["status", "id", "trigger", "subject", "target", "activity"] });
}

function renderBinding(binding: BindingRow): string {
  return [
    `${bindingStatus(binding.status)}  ${c.dim("binding")} ${c.bold(binding.id)}`,
    "",
    fields([
      ["trigger", binding.triggerId],
      ["router", binding.router],
      ["subject", binding.subjectKey],
      ["status", binding.status],
      binding.target ? ["target", `${binding.target.kind}:${binding.target.handle}`] : null,
      binding.target?.handles ? ["targets", Object.entries(binding.target.handles).map(([id, handle]) => `${id}=${handle}`).join(", ")] : null,
      binding.lastEventKind ? ["last event", binding.lastEventKind] : null,
      binding.error ? ["error", c.red(binding.error)] : null,
    ]),
  ].join("\n");
}

function bindingStatus(status: BindingRow["status"]): string {
  if (status === "active") return c.green("active");
  if (status === "pending" || status === "closing") return c.yellow(status);
  if (status === "errored") return c.red(status);
  return c.gray(status);
}

function renderJobList(jobs: Job[]): string {
  if (!jobs.length) return c.dim("No jobs yet.");
  const termWidth = process.stdout.columns || 80;
  const rows = jobs.map((job) => [
    jobBadge(job.status),
    c.dim(shortId(job.id)),
    c.bold(job.triggerId),
    relativeTime(job.queuedAt),
    job.error ? c.red(truncate(job.error, Math.max(20, termWidth - 50))) : "",
  ]);
  return table(rows, { head: ["status", "job", "trigger", "queued", ""] });
}

async function cmdJob(store: PollinateStore, args: ParsedArgs): Promise<void> {
  if (args.rest[0] === "cancel") {
    const job = await store.cancelJob(requiredArg(args.rest[1], "Usage: pollinate job cancel <jobId>"));
    print(args, job, `${jobBadge(job.status)}  ${c.dim("job")} ${c.bold(shortId(job.id))}`);
    return;
  }
  const job = await store.getJob(requiredArg(args.rest[0], "Usage: pollinate job <jobId>"));
  if (!job) throw new Error(`No job found with id "${args.rest[0]}"`);
  print(args, job, renderJob(job));
}

function renderJob(job: Job): string {
  const took = jobDuration(job);
  const lines = [
    `${jobBadge(job.status)}  ${c.dim(job.id)}`,
    "",
    fields([
      ["trigger", c.bold(job.triggerId)],
      ["source", sourceLabel(job.source)],
      ["queued", timestampField(job.queuedAt)],
      job.startedAt ? ["started", timestampField(job.startedAt)] : null,
      job.completedAt ? ["finished", timestampField(job.completedAt)] : null,
      took ? ["duration", formatDuration(took)] : null,
      job.cwd ? ["cwd", c.dim(job.cwd)] : null,
      job.action ? ["action", describeAction(job.action)] : null,
      Object.keys(job.context).length ? ["context", describeContext(job.context)] : null,
    ]),
  ];
  if (job.error) {
    lines.push("");
    lines.push(say.fail(c.red(job.error)));
  }
  if (job.result !== undefined && job.result !== null) {
    lines.push("");
    lines.push(c.dim("result"));
    lines.push(indentBlock(JSON.stringify(job.result, null, 2), 2));
  }
  return lines.join("\n");
}

async function cmdHooks(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const hooks = (await store.loadTriggers())
    .filter((trigger) => trigger.source.kind === "webhook")
    .map((trigger) => ({
      triggerId: trigger.id,
      path: `/hook/${trigger.source.kind === "webhook" ? trigger.source.webhook.path : ""}`,
      secretConfigured: Boolean(trigger.source.kind === "webhook" && trigger.source.webhook.secret),
      enabled: trigger.enabled,
    }));
  print(args, hooks, renderHookList(hooks));
}

type HookRow = { triggerId: string; path: string; secretConfigured: boolean; enabled: boolean };

function renderHookList(hooks: HookRow[]): string {
  if (!hooks.length) {
    return [
      c.dim("No webhook triggers."),
      say.hint(`add one with ${c.bold("pol create <id> --source webhook --path <route> --action …")}`),
    ].join("\n");
  }
  const rows = hooks.map((hook) => [
    statusDot(hook.enabled),
    c.bold(hook.triggerId),
    c.cyan(hook.path),
    hook.secretConfigured ? c.green(`${sym.check} secret`) : c.dim(`${sym.off} none`),
  ]);
  return table(rows, { head: ["", "trigger", "path", "secret"] });
}

async function cmdHook(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const sub = requiredArg(args.rest[0], "Usage: pollinate hook <create|inbox|wait|gc|test> ...");
  if (sub === "create") {
    const created = await createHookFromArgs(store, args, {});
    print(args, hookCreateJson(created), renderHookCreated(created));
    return;
  }
  if (sub === "inbox") {
    const created = await createHookFromArgs(store, args, { defaultTtl: "1h", subjectPrefix: "pollinate.inbox" });
    print(args, hookCreateJson(created), renderHookCreated(created));
    return;
  }
  if (sub === "wait") {
    await cmdHookWait(store, args);
    return;
  }
  if (sub === "gc") {
    const removed = await gcTemporaryHooks(store);
    print(args, { removed }, removed.length ? say.ok(`removed ${removed.length} expired temporary ${plural(removed.length, "hook")}`) : c.dim("No expired temporary hooks."));
    return;
  }
  if (sub !== "test") throw new Error("Usage: pollinate hook <create|inbox|wait|gc|test> ...");
  const trigger = await store.requireTrigger(requiredArg(args.rest[1], "Usage: pollinate hook test <id> --payload '{...}'"));
  if (trigger.source.kind !== "webhook") throw new Error(`Trigger ${trigger.id} is not a webhook trigger`);
  const payload = parsePayload(stringFlag(args, "payload") ?? "{}");
  const transformed = trigger.router ? payload : applyWebhookTransform(trigger.source.webhook, payload);
  const activation: Activation = {
    triggerId: trigger.id,
    source: "webhook",
    payload: transformed,
    receivedAt: nowIso(),
    metadata: {
      webhook: {
        path: trigger.source.webhook.path,
        headers: keyValueRecord(flagValues(args, "header")) ?? {},
      },
    },
  };
  const executor = await newExecutor(store);
  const job = await executor.createQueuedJob(trigger, activation, [transformed]);
  await store.saveJob(job);
  await store.appendLedger({ event: "pollinate.webhook.received", trigger_id: trigger.id, path: trigger.source.webhook.path, source_ip: "hook-test", at: nowIso() });
  await store.appendLedger({ event: "pollinate.job.queued", job_id: job.id, trigger_id: trigger.id, queue_position: 0, at: nowIso() });
  const completed = await runWithSpinner(args, `testing hook ${c.bold(trigger.id)}…`, () =>
    executor.executeJob(job, trigger, activation, [transformed]),
  );
  print(args, completed, renderJobOutcome(completed));
}

async function cmdHookWait(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const ttl = stringFlag(args, "ttl") ?? "10m";
  const created = await createHookFromArgs(store, args, { defaultTtl: ttl, defaultMaxDeliveries: 1, subjectPrefix: "pollinate.wait" });
  if (!args.json) console.log(renderHookCreated(created));
  const timeoutMs = parseDuration(ttl);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const jobs = await store.listJobs({ triggerId: created.trigger.id, last: 20 });
      const completed = jobs.find((job) => TERMINAL.has(job.status));
      if (completed) {
        await store.removeTrigger(created.trigger.id).catch(() => undefined);
        print(args, { ...hookCreateJson(created), payload: completed.batch?.[0], job: completed }, `${jobBadge(completed.status)} ${c.bold(created.trigger.id)}`);
        return;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${created.url ?? `/hook/${created.path}`}`);
      await sleep(100);
    }
  } catch (error) {
    await store.removeTrigger(created.trigger.id).catch(() => undefined);
    throw error;
  }
}

type HookCreateDefaults = {
  defaultTtl?: string;
  defaultMaxDeliveries?: number;
  subjectPrefix?: string;
};

async function createHookFromArgs(store: PollinateStore, args: ParsedArgs, defaults: HookCreateDefaults): Promise<HookCreateResult> {
  const id = slugify(args.rest[1] ?? `hook-${randomHookToken().slice(0, 8)}`);
  const ttl = stringFlag(args, "ttl") ?? defaults.defaultTtl;
  const maxDeliveries = args.flags.once ? 1 : (numberFlag(args, "max-deliveries") ?? defaults.defaultMaxDeliveries);
  const config = await store.daemonConfig();
  const baseUrl = stringFlag(args, "base-url") ?? config.webhook.publicUrl;
  const created = createWebhookHook({
    id,
    path: stringFlag(args, "path"),
    ttl,
    baseUrl,
    secret: stringFlag(args, "secret"),
    transform: keyValueRecord(flagValues(args, "transform")),
    maxDeliveries,
    action: actionFromFlagsOrDefault(args, {
      kind: "emit",
      subject: `${defaults.subjectPrefix ?? "pollinate.hook"}.${id}`,
      payload: "{{event}}",
    }),
    delivery: deliveryFromFlags(args),
    tags: ["temporary", ...flagValues(args, "tag")],
  });
  await store.saveTrigger(created.trigger);
  await store.appendLedger({
    event: "pollinate.hook.created",
    trigger_id: created.id,
    path: created.path,
    url: created.url,
    expires_at: created.expiresAt,
    max_deliveries: created.maxDeliveries,
  });
  return created;
}

function actionFromFlagsOrDefault(args: ParsedArgs, fallback: Action): Action {
  if (stringFlag(args, "action") || stringFlag(args, "action-json") || stringFlag(args, "command")) return actionFromFlags(args);
  return fallback;
}

function actionFromFlagsOptional(args: ParsedArgs): Action | undefined {
  if (stringFlag(args, "action") || stringFlag(args, "action-json") || stringFlag(args, "command")) return actionFromFlags(args);
  return undefined;
}

function hookCreateJson(created: HookCreateResult): Record<string, unknown> {
  return {
    id: created.id,
    path: created.path,
    url: created.url,
    expiresAt: created.expiresAt,
    maxDeliveries: created.maxDeliveries,
    trigger: created.trigger,
  };
}

function renderHookCreated(created: HookCreateResult): string {
  const target = created.url ?? `/hook/${created.path}`;
  const lines = [`${say.ok(`created ${c.bold(created.id)}`)}  ${c.cyan(target)}`];
  if (created.expiresAt) lines.push(`  ${field("expires", timestampField(created.expiresAt))}`);
  if (created.maxDeliveries) lines.push(`  ${field("deliveries", String(created.maxDeliveries))}`);
  return lines.join("\n");
}

async function cmdDaemon(args: ParsedArgs): Promise<void> {
  const sub = requiredArg(args.rest[0], "Usage: pollinate daemon <install|uninstall|start|stop|restart|status|logs|run>");
  if (sub === "run") {
    if (!args.flags.foreground) throw new Error("Usage: pollinate daemon run --foreground");
    await runForeground();
    return;
  }
  if (sub === "install") {
    const path = await installDaemon();
    print(args, { installed: path }, `${say.ok("installed daemon service")}\n  ${c.dim(path)}`);
    return;
  }
  if (sub === "uninstall") {
    await uninstallDaemon();
    print(args, { uninstalled: true }, say.ok("uninstalled daemon"));
    return;
  }
  if (sub === "start") {
    await startDaemon();
    print(args, { started: true }, say.ok("started daemon"));
    return;
  }
  if (sub === "stop") {
    await stopDaemon();
    print(args, { stopped: true }, say.ok("stopped daemon"));
    return;
  }
  if (sub === "restart") {
    await restartDaemon();
    print(args, { restarted: true }, say.ok("restarted daemon"));
    return;
  }
  if (sub === "status") {
    const status = await daemonStatus();
    print(args, { status }, `${heading("daemon")}\n${indentBlock(c.dim(status.trim()), 2)}`);
    return;
  }
  if (sub === "logs") {
    const logs = await daemonLogs(numberFlag(args, "lines") ?? 100);
    print(args, { logs }, `${heading("daemon logs")}\n${indentBlock(logs, 2)}`);
    return;
  }
  throw new Error(`Unknown daemon command: ${sub}`);
}

async function cmdSatellite(args: ParsedArgs): Promise<void> {
  const sub = requiredArg(args.rest[0], "Usage: pollinate satellite run --target <url> --secret <secret> [--bind 0.0.0.0] [--port 3979]");
  if (sub !== "run") throw new Error(`Unknown satellite command: ${sub}`);
  const server = new SatelliteServer({
    bind: stringFlag(args, "bind") ?? "0.0.0.0",
    port: numberFlag(args, "port") ?? 3979,
    target: requiredFlag(args, "target", "Satellite mode requires --target <local-daemon-base-url>"),
    relaySecret: requiredFlag(args, "secret", "Satellite mode requires --secret <secret-or-env:NAME>"),
    forwardTimeoutMs: parseDuration(stringFlag(args, "timeout"), 10_000),
  });
  await server.start();
  const address = server.address();
  print(
    args,
    { listening: address, target: stringFlag(args, "target") },
    `${say.ok("satellite listening")}  ${c.dim(`${address?.address ?? "0.0.0.0"}:${address?.port ?? numberFlag(args, "port") ?? 3979} -> ${stringFlag(args, "target")}`)}`,
  );
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await new Promise<void>(() => undefined);
}

async function cmdGithub(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const sub = requiredArg(args.rest[0], "Usage: pollinate github <install-pr-router|create-pr-router> ...");
  if (sub === "install-pr-router") {
    await cmdGithubInstallPrRouter(store, args);
    return;
  }
  if (sub === "create-pr-router") {
    await cmdGithubCreatePrRouter(store, args);
    return;
  }
  throw new Error("Usage: pollinate github <install-pr-router|create-pr-router> ...");
}

async function cmdGithubInstallPrRouter(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const triggerId = requiredArg(args.rest[1], "Usage: pollinate github install-pr-router <trigger-id> --repo owner/repo [--base-url https://...]");
  const trigger = await store.requireTrigger(triggerId);
  if (trigger.source.kind !== "webhook") throw new Error(`Trigger ${trigger.id} is not a webhook trigger`);
  if (!trigger.router) throw new Error(`Trigger ${trigger.id} is not a router trigger`);
  const config = await store.daemonConfig();
  const dryRun = Boolean(args.flags["dry-run"]);
  const url = githubWebhookUrl(args, config.webhook.publicUrl, trigger.source.webhook.path);
  const secretRaw = stringFlag(args, "secret") ?? trigger.source.webhook.secret;
  const result = await installGithubWebhook({
    repo: requiredFlag(args, "repo", "GitHub PR router install requires --repo owner/repo"),
    url,
    secret: dryRun || !secretRaw ? secretRaw : resolveSecret(secretRaw),
    events: flagValues(args, "event"),
    dryRun,
    timeoutMs: parseDuration(stringFlag(args, "timeout"), 60_000),
    execution: (await store.daemonConfig()).execution,
  });
  if (!dryRun) {
    await store.appendLedger({
      event: "pollinate.github.webhook.installed",
      trigger_id: trigger.id,
      repo: result.repo,
      url: result.url,
      action: result.action,
      hook_id: result.hookId,
    });
  }
  print(args, result, renderGithubWebhookInstall(result));
}

async function cmdGithubCreatePrRouter(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const id = slugify(requiredArg(args.rest[1], "Usage: pollinate github create-pr-router <id> --repo owner/repo [--cwd <repo-dir>]"));
  const repo = requiredFlag(args, "repo", "GitHub PR router creation requires --repo owner/repo");
  const dryRun = Boolean(args.flags["dry-run"]);
  const now = nowIso();
  const trigger = githubPrRouterTrigger({
    id,
    repo,
    cwd: stringFlag(args, "cwd") ?? process.cwd(),
    path: stringFlag(args, "path") ?? `github/${repo.replace(/[^A-Za-z0-9_.-]+/g, "-")}/pr`,
    secret: stringFlag(args, "secret"),
    reviewers: reviewersFromFlags(args),
    tags: flagValues(args, "tag"),
    now,
  });
  let install: Awaited<ReturnType<typeof installGithubWebhook>> | undefined;
  if (!dryRun) {
    await store.saveTrigger(trigger);
    await store.appendLedger({ event: "pollinate.trigger.added", trigger_id: trigger.id, via: "github-create-pr-router", repo });
  }
  if (args.flags["install-webhook"]) {
    const config = await store.daemonConfig();
    const url = githubWebhookUrl(args, config.webhook.publicUrl, trigger.source.kind === "webhook" ? trigger.source.webhook.path : "");
    const secretRaw = trigger.source.kind === "webhook" ? trigger.source.webhook.secret : undefined;
    install = await installGithubWebhook({
      repo,
      url,
      secret: dryRun || !secretRaw ? secretRaw : resolveSecret(secretRaw),
      events: flagValues(args, "event"),
      dryRun,
      timeoutMs: parseDuration(stringFlag(args, "timeout"), 60_000),
      execution: (await store.daemonConfig()).execution,
    });
    if (!dryRun) {
      await store.appendLedger({
        event: "pollinate.github.webhook.installed",
        trigger_id: trigger.id,
        repo: install.repo,
        url: install.url,
        action: install.action,
        hook_id: install.hookId,
      });
    }
  }
  const payload = install ? { trigger, webhook: install } : { trigger };
  const human = [
    dryRun ? say.warn(`dry run for ${c.bold(trigger.id)}`) : say.ok(`created ${c.bold(trigger.id)}`),
    c.dim(triggerSummary(trigger)),
    install ? renderGithubWebhookInstall(install) : say.hint(`install webhook with ${c.bold(`pol github install-pr-router ${trigger.id} --repo ${repo}`)}`),
  ].join("\n");
  print(args, payload, human);
}

type ReviewerSpec = { id: string; bee: string };

function reviewersFromFlags(args: ParsedArgs): ReviewerSpec[] {
  const values = [...flagValues(args, "reviewer"), ...flagValues(args, "review-bee")];
  if (!values.length) return [{ id: "reviewer", bee: stringFlag(args, "bee") ?? "codex" }];
  return values.map((value) => {
    const [id, bee] = splitKeyValue(value);
    return { id: slugify(id), bee };
  });
}

function githubPrRouterTrigger(input: {
  id: string;
  repo: string;
  cwd: string;
  path: string;
  secret?: string;
  reviewers: ReviewerSpec[];
  tags: string[];
  now: string;
}): Trigger {
  const reviewers = input.reviewers.length ? input.reviewers : [{ id: "reviewer", bee: "codex" }];
  const swarm = reviewers.length > 1;
  const spawnArgs = ["--allowedTools", "Bash(gh pr view *),Bash(gh pr diff *),Bash(gh pr comment *),Read,Grep,Glob,LS"];
  return {
    id: input.id,
    name: input.id,
    description: `Professional PR review router for ${input.repo}`,
    cwd: input.cwd,
    tags: ["github", "pr-router", "review", ...input.tags],
    enabled: true,
    source: { kind: "webhook", webhook: { path: input.path, ...(input.secret ? { secret: input.secret } : {}) } },
    delivery: { mode: { strategy: "immediate" }, maxConcurrent: 4 },
    router: {
      plugin: "github-pr",
      openOn: ["github.pull_request.opened", "github.pull_request.reopened", "github.pull_request.ready_for_review"],
      closeOn: ["github.pull_request.closed", "github.pull_request.merged"],
      onOpen: swarm
        ? {
            kind: "sequence",
            mode: "parallel",
            primary: reviewers[0]!.id,
            actions: reviewers.map((reviewer) => ({
              id: reviewer.id,
              action: {
                kind: "honeybee",
                run: "spawn",
                bee: reviewer.bee,
                name: `${input.id}-${reviewer.id}-{{pr_number}}`,
                cwd: input.cwd,
                yolo: false,
                args: spawnArgs,
                message: professionalOpenPrompt(reviewer.id),
              },
            })),
          }
        : {
            kind: "honeybee",
            run: "spawn",
            bee: reviewers[0]!.bee,
            name: `${input.id}-{{pr_number}}`,
            cwd: input.cwd,
            yolo: false,
            args: spawnArgs,
            message: professionalOpenPrompt(reviewers[0]!.id),
          },
      onActivity: swarm
        ? {
            kind: "sequence",
            mode: "parallel",
            primary: reviewers[0]!.id,
            actions: reviewers.map((reviewer) => ({
              id: reviewer.id,
              action: {
                kind: "honeybee",
                run: "send",
                target: `{{binding.targets.${reviewer.id}}}`,
                message: professionalActivityPrompt(reviewer.id),
              },
            })),
          }
        : {
            kind: "honeybee",
            run: "send",
            target: "{{binding.target}}",
            message: professionalActivityPrompt(reviewers[0]!.id),
          },
      onClose: swarm
        ? {
            kind: "sequence",
            mode: "parallel",
            primary: reviewers[0]!.id,
            continueOnError: true,
            actions: reviewers.map((reviewer) => ({
              id: reviewer.id,
              action: { kind: "honeybee", run: "kill", target: `{{binding.targets.${reviewer.id}}}` },
            })),
          }
        : { kind: "honeybee", run: "kill", target: "{{binding.target}}" },
    },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function professionalOpenPrompt(reviewerId: string): string {
  return [
    `You are reviewer ${reviewerId} for PR {{repo}}#{{pr_number}}: {{pr_title}}.`,
    "Perform a professional code review. Inspect PR metadata and diff with gh.",
    "Focus on correctness, regressions, security, data loss, concurrency, API compatibility, and missing tests.",
    "Do not modify code. Post a concise PR comment only when you have useful findings or a clear review result.",
    "If you post a PR comment, include <!-- pollinate-router --> at the top.",
  ].join(" ");
}

function professionalActivityPrompt(reviewerId: string): string {
  return [
    `Reviewer ${reviewerId}: new activity arrived for PR {{repo}}#{{pr_number}}.`,
    "{{activity_markdown}}",
    "Re-check only what changed or what the activity asks for. Do not modify code.",
    "If you post a PR comment, include <!-- pollinate-router --> at the top.",
  ].join("\n\n");
}

function githubWebhookUrl(args: ParsedArgs, configuredPublicUrl: string | undefined, path: string): string {
  const explicit = stringFlag(args, "url");
  if (explicit) return explicit;
  const baseUrl = stringFlag(args, "base-url") ?? configuredPublicUrl;
  if (!baseUrl) throw new Error("GitHub webhook install requires --url or --base-url, or [webhook].publicUrl in pollinate.toml");
  return `${baseUrl.replace(/\/+$/, "")}/hook/${path.replace(/^\/+/, "")}`;
}

function renderGithubWebhookInstall(result: Awaited<ReturnType<typeof installGithubWebhook>>): string {
  const status = result.action === "dry-run" ? say.warn("dry-run github webhook") : say.ok(`${result.action} github webhook`);
  return [
    `${status}  ${c.bold(result.repo)}`,
    `  ${field("url", c.cyan(result.url))}`,
    `  ${field("events", result.events.join(", "))}`,
    result.hookId ? `  ${field("hook", String(result.hookId))}` : `  ${field("hook", c.dim("-"))}`,
  ].join("\n");
}

async function cmdStatus(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const [triggers, jobs, scheduleState, deliveryState] = await Promise.all([
    store.loadTriggers(),
    store.listJobs({ last: 1000 }),
    store.readScheduleState(),
    store.readDeliveryState(),
  ]);
  const active = triggers.filter((trigger) => trigger.enabled);
  const queued = jobs.filter((job) => job.status === "queued").length;
  const running = jobs.filter((job) => job.status === "running" || job.status === "resolving-context").length;
  const status = {
    triggers: { total: triggers.length, enabled: active.length, disabled: triggers.length - active.length },
    jobs: { queued, running },
    nextFires: Object.fromEntries(Object.entries(scheduleState).map(([id, state]) => [id, state.nextFireAt])),
    delivery: deliveryState,
  };
  print(args, status, renderStatus(store, triggers, active.length, queued, running, scheduleState, deliveryState));
}

function renderStatus(
  store: PollinateStore,
  triggers: Trigger[],
  enabled: number,
  queued: number,
  running: number,
  scheduleState: Awaited<ReturnType<PollinateStore["readScheduleState"]>>,
  deliveryState: Awaited<ReturnType<PollinateStore["readDeliveryState"]>>,
): string {
  const disabled = triggers.length - enabled;
  const pending = Object.values(deliveryState).filter((d) => d.pendingBatch?.length || d.queue?.length).length;
  const summary = box(
    [
      field("triggers", `${c.bold(c.green(String(enabled)))} ${c.dim("enabled")} ${c.dim(sym.mid)} ${c.dim(`${disabled} disabled`)}`, 9),
      field("jobs", `${countTag(queued, "queued", c.blue)} ${c.dim(sym.mid)} ${countTag(running, "running", c.yellow)}`, 9),
      field("delivery", pending ? countTag(pending, "pending", c.yellow) : c.dim("idle"), 9),
      field("store", c.dim(store.root), 9),
    ],
    { title: "pollinate" },
  );
  const upcoming = Object.entries(scheduleState)
    .filter(([, state]) => state.nextFireAt)
    .sort((a, b) => String(a[1].nextFireAt).localeCompare(String(b[1].nextFireAt)))
    .slice(0, 8);
  if (!upcoming.length) return summary;
  const labelWidth = Math.max(...upcoming.map(([id]) => id.length));
  const list = upcoming
    .map(([id, state]) => `  ${c.cyan(sym.dot)} ${pad(c.bold(id), labelWidth)}  ${c.dim(relativeTime(state.nextFireAt))}`)
    .join("\n");
  return `${summary}\n\n${c.dim("upcoming fires")}\n${list}`;
}

async function cmdLedger(store: PollinateStore, args: ParsedArgs): Promise<void> {
  const lines = numberFlag(args, "n") ?? numberFlag(args, "lines");
  if (!args.flags.follow) {
    const ledger = await store.readLedger(lines);
    const human = ledger.length ? ledger.map(renderLedgerLine).join("\n") : c.dim("Ledger is empty.");
    print(args, ledger, human);
    return;
  }
  let seen = (await store.readLedger()).length;
  for (;;) {
    const ledger = await store.readLedger();
    for (const line of ledger.slice(seen)) console.log(args.json ? line : renderLedgerLine(line));
    seen = ledger.length;
    await sleep(1_000);
  }
}

function renderLedgerLine(raw: string): string {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.dim(raw);
  }
  const ts = typeof event.ts === "string" ? new Date(event.ts) : null;
  const clock = ts && !Number.isNaN(ts.getTime()) ? clockTime(ts) : "--:--:--";
  const name = colorEventName(String(event.event ?? "?"));
  const extras = ledgerExtras(event);
  return `${c.dim(clock)}  ${name}${extras ? `  ${extras}` : ""}`;
}

function colorEventName(name: string): string {
  const dot = name.lastIndexOf(".");
  const prefix = dot >= 0 ? name.slice(0, dot + 1) : "";
  const verb = dot >= 0 ? name.slice(dot + 1) : name;
  const color =
    /complete|added|started|enabled|installed|received/.test(verb)
      ? c.green
      : /error|fail|timed|timeout/.test(verb)
        ? c.red
        : /queued|fired|emit/.test(verb)
          ? c.blue
          : /cancel|skip|disabled|removed/.test(verb)
            ? c.gray
            : c.cyan;
  return `${c.dim(prefix)}${color(verb)}`;
}

const LEDGER_KEYS: Array<[string, string]> = [
  ["trigger_id", "trigger"],
  ["job_id", "job"],
  ["path", "path"],
  ["subject", "subject"],
  ["queue_position", "pos"],
  ["source_ip", "from"],
  ["via", "via"],
];

function ledgerExtras(event: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, label] of LEDGER_KEYS) {
    const value = event[key];
    if (value === undefined || value === null) continue;
    // Job ids are random hashes worth shortening; trigger ids are human names.
    const text = key === "job_id" ? shortId(String(value)) : String(value);
    parts.push(`${c.dim(`${label}=`)}${text}`);
  }
  return parts.join(c.dim(" · "));
}

async function newExecutor(store: PollinateStore): Promise<ActionExecutor> {
  const config = await store.daemonConfig();
  return new ActionExecutor(store, {
    contextTimeoutMs: parseDuration(config.defaults.contextTimeout, 5_000),
    commandTimeoutMs: parseDuration(config.defaults.commandTimeout, 600_000),
    execution: config.execution,
  });
}

function renderTrigger(trigger: Trigger): string {
  const state = trigger.enabled ? c.green("enabled") : c.gray("disabled");
  const headline = `${c.accent(sym.flower)} ${c.bold(trigger.id)}  ${statusDot(trigger.enabled)} ${state}`;
  const subtitle = c.dim(`${trigger.source.kind} ${sym.arrow} ${trigger.router ? `router:${trigger.router.plugin}` : trigger.action?.kind ?? "none"}`);
  const pairs: Array<[string, string] | null> = [
    trigger.name && trigger.name !== trigger.id ? ["name", trigger.name] : null,
    trigger.description ? ["description", trigger.description] : null,
    trigger.cwd ? ["cwd", c.dim(trigger.cwd)] : null,
    trigger.tags.length ? ["tags", c.gray(trigger.tags.join(", "))] : null,
    ["source", `${sourceLabel(trigger.source.kind)} ${c.dim(sym.mid)} ${sourceDetail(trigger.source)}`],
    ["delivery", describeDelivery(trigger.delivery)],
    trigger.filter ? ["filter", c.dim(compactJson(trigger.filter))] : null,
    trigger.context ? ["context", describeContext(contextVars(trigger.context))] : null,
    trigger.router ? ["router", describeRouter(trigger.router)] : null,
    trigger.action ? ["action", describeAction(trigger.action)] : null,
  ];
  const lines = [headline, subtitle, "", fields(pairs)];
  const detail = trigger.action ? actionDetail(trigger.action) : undefined;
  if (detail) {
    const labelWidth = Math.max(...(pairs.filter(Boolean) as [string, string][]).map(([l]) => l.length));
    lines.push(field("", c.dim(detail), labelWidth));
  }
  lines.push("");
  lines.push(c.dim(`created ${relativeTime(trigger.createdAt)} ${sym.mid} updated ${relativeTime(trigger.updatedAt)}`));
  return lines.join("\n");
}

// --- shared rendering helpers ---------------------------------------------

function triggerSummary(trigger: Trigger): string {
  return `${trigger.source.kind} ${sym.arrow} ${trigger.router ? `router:${trigger.router.plugin}` : trigger.action?.kind ?? "none"}`;
}

function sourceDetail(source: Source): string {
  switch (source.kind) {
    case "manual":
      return "on demand";
    case "schedule": {
      const t = source.timing;
      if (t.type === "every") return `every ${t.interval}`;
      if (t.type === "cron") return `cron ${t.expression}${t.timezone && t.timezone !== "UTC" ? ` (${t.timezone})` : ""}`;
      return `once at ${t.at}`;
    }
    case "webhook":
      return `/hook/${source.webhook.path}${source.webhook.secret ? ` ${sym.mid} secured` : ""}`;
    case "poll":
      return `every ${source.poll.interval} ${sym.mid} ${source.poll.fetch.kind}`;
    default:
      return "";
  }
}

function describeDelivery(delivery: Delivery): string {
  const mode = delivery.mode;
  let label: string;
  switch (mode.strategy) {
    case "immediate":
      label = "immediate";
      break;
    case "throttled":
      label = `throttled ${mode.interval}${mode.collect ? " (collect)" : ""}`;
      break;
    case "batched":
      label = `batched window ${mode.window} max ${mode.maxBatch}`;
      break;
    case "debounced":
      label = `debounced ${mode.quietPeriod}`;
      break;
    default:
      label = (mode as { strategy: string }).strategy;
  }
  return `${label} ${c.dim(`${sym.mid} max ${delivery.maxConcurrent}`)}`;
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case "command":
      return `${c.bold("command")}`;
    case "http":
      return `${c.bold("http")} ${action.method} ${c.dim(action.url)}`;
    case "emit":
      return `${c.bold("emit")} ${action.subject}`;
    case "hermes":
      return `${c.bold("hermes")} ${action.invoke}`;
    case "honeybee":
      if (action.run === "flow") return `${c.bold("honeybee")} flow ${action.flow}`;
      if (action.run === "loop") return `${c.bold("honeybee")} loop`;
      return `${c.bold("honeybee")} ${action.run}`;
    case "sequence":
      return `${c.bold("sequence")} ${action.mode ?? "serial"} ${c.dim(`${action.actions.length} actions`)}`;
    default:
      return (action as { kind: string }).kind;
  }
}

function describeRouter(router: NonNullable<Trigger["router"]>): string {
  return `${c.bold(router.plugin)} ${c.dim(`${sym.mid} open ${router.openOn.length} close ${router.closeOn.length}`)}`;
}

function actionDetail(action: Action): string | undefined {
  const max = Math.max(20, (process.stdout.columns || 80) - 16);
  if (action.kind === "command") return truncate(action.command, max);
  if (action.kind === "http" && action.body) return truncate(action.body, max);
  if ((action.kind === "emit" || action.kind === "hermes") && action.payload) return truncate(action.payload, max);
  if (action.kind === "sequence") return action.actions.map((step) => step.id ?? step.action.kind).join(", ");
  return undefined;
}

function contextVars(context: ContextResolver): Record<string, string> {
  const out: Record<string, string> = { ...(context.static ?? {}) };
  for (const source of context.sources ?? []) out[source.var] = `<${source.kind}>`;
  return out;
}

function describeContext(record: Record<string, string>): string {
  const keys = Object.keys(record);
  if (!keys.length) return c.dim("none");
  return keys.map((k) => `${c.dim(`${k}=`)}${record[k]}`).join(c.dim(" · "));
}

function compactJson(value: unknown): string {
  return truncate(JSON.stringify(value), Math.max(20, (process.stdout.columns || 80) - 16));
}

function jobDuration(job: Job): number | undefined {
  if (!job.startedAt || !job.completedAt) return undefined;
  const span = new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
  return Number.isFinite(span) && span >= 0 ? span : undefined;
}

function timestampField(iso: string): string {
  return `${relativeTime(iso)} ${c.dim(`(${iso})`)}`;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function clockTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}

function countTag(count: number, label: string, color: (s: string) => string): string {
  const shown = count > 0 ? color(c.bold(String(count))) : c.dim("0");
  return `${shown} ${c.dim(label)}`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

async function runWithSpinner<T>(args: ParsedArgs, label: string, work: () => Promise<T>): Promise<T> {
  const stop = args.json ? () => {} : spinner(label);
  try {
    return await work();
  } finally {
    stop();
  }
}

function parsePayload(raw: string): JsonValueForCli {
  try {
    return JSON.parse(raw) as JsonValueForCli;
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type JsonValueForCli = Activation["payload"];

function sourceFromFlags(args: ParsedArgs): Source {
  const json = jsonFlag<Source>(args, "source-json");
  if (json) return json;
  const source = stringFlag(args, "source") ?? inferSourceKind(args);
  if (source === "manual") return { kind: "manual" };
  if (source === "schedule" || source === "every" || source === "cron" || source === "once") {
    const missedFirePolicy = stringFlag(args, "missed-fire-policy") as MissedFirePolicy | undefined;
    if (source === "cron" || stringFlag(args, "cron")) {
      return {
        kind: "schedule",
        timing: {
          type: "cron",
          expression: requiredFlag(args, "cron", "Cron schedules require --cron '<expr>'"),
          timezone: stringFlag(args, "timezone") ?? "UTC",
          ...(missedFirePolicy ? { missedFirePolicy } : {}),
        },
      };
    }
    if (source === "once" || stringFlag(args, "once")) {
      return {
        kind: "schedule",
        timing: {
          type: "once",
          at: requiredFlag(args, "once", "Once schedules require --once <iso>"),
          ...(missedFirePolicy ? { missedFirePolicy } : {}),
        },
      };
    }
    return {
      kind: "schedule",
      timing: {
        type: "every",
        interval: requiredFlag(args, "every", "Every schedules require --every <duration>"),
        ...(missedFirePolicy ? { missedFirePolicy } : {}),
      },
    };
  }
  if (source === "webhook") {
    return {
      kind: "webhook",
      webhook: {
        path: requiredFlag(args, "path", "Webhook sources require --path <route>"),
        secret: stringFlag(args, "secret"),
        transform: keyValueRecord(flagValues(args, "transform")),
      },
    };
  }
  if (source === "poll") {
    const fetchCommand = stringFlag(args, "fetch-command");
    const fetchHttp = stringFlag(args, "fetch-http");
    const fetchFile = stringFlag(args, "fetch-file");
    const cursor = stringFlag(args, "cursor") ?? (stringFlag(args, "cursor-jsonpath") ? "jsonpath" : "hash");
    return {
      kind: "poll",
      poll: {
        interval: requiredFlag(args, "poll-interval", "Poll sources require --poll-interval <duration>"),
        emit: (stringFlag(args, "emit") as "per-item" | "per-poll" | undefined) ?? "per-item",
        fetch: fetchCommand
          ? { kind: "command", command: fetchCommand }
          : fetchHttp
            ? { kind: "http", method: stringFlag(args, "fetch-method") ?? "GET", url: fetchHttp, headers: keyValueRecord(flagValues(args, "header")) }
            : { kind: "file", path: fetchFile ?? requiredFlag(args, "fetch-file", "Poll sources require one of --fetch-command, --fetch-http, or --fetch-file") },
        cursor:
          cursor === "jsonpath"
            ? { strategy: "jsonpath", jsonpath: requiredFlag(args, "cursor-jsonpath", "jsonpath cursors require --cursor-jsonpath <expr>") }
            : cursor === "append-offset"
              ? { strategy: "append-offset" }
              : { strategy: "hash" },
      },
    };
  }
  throw new Error(`Unsupported --source value: ${source}`);
}

function deliveryFromFlags(args: ParsedArgs): Delivery {
  const json = jsonFlag<Delivery>(args, "delivery-json");
  if (json) return json;
  const strategy = stringFlag(args, "delivery") ?? "immediate";
  const maxConcurrent = numberFlag(args, "max-concurrent") ?? numberFlag(args, "maxConcurrent") ?? 1;
  if (strategy === "immediate") return { mode: { strategy }, maxConcurrent };
  if (strategy === "throttled") {
    return {
      mode: {
        strategy,
        interval: requiredFlag(args, "delivery-interval", "Throttled delivery requires --delivery-interval <duration>"),
        collect: Boolean(args.flags.collect),
      },
      maxConcurrent,
    };
  }
  if (strategy === "batched") {
    return {
      mode: {
        strategy,
        window: requiredFlag(args, "window", "Batched delivery requires --window <duration>"),
        maxBatch: numberFlag(args, "max-batch") ?? 1,
      },
      maxConcurrent,
    };
  }
  if (strategy === "debounced") {
    return {
      mode: {
        strategy,
        quietPeriod: requiredFlag(args, "quiet-period", "Debounced delivery requires --quiet-period <duration>"),
      },
      maxConcurrent,
    };
  }
  throw new Error(`Unsupported --delivery value: ${strategy}`);
}

function actionFromFlags(args: ParsedArgs): Action {
  const json = jsonFlag<Action>(args, "action-json");
  if (json) return json;
  const action = stringFlag(args, "action") ?? (stringFlag(args, "command") ? "command" : undefined);
  if (action === "command") {
    return {
      kind: "command",
      command: requiredFlag(args, "command", "Command actions require --command <shell-command>"),
      timeout: stringFlag(args, "timeout"),
    };
  }
  if (action === "http") {
    return {
      kind: "http",
      method: stringFlag(args, "method") ?? "POST",
      url: requiredFlag(args, "url", "HTTP actions require --url <url>"),
      headers: keyValueRecord(flagValues(args, "header")),
      body: stringFlag(args, "body"),
      timeout: stringFlag(args, "timeout"),
    };
  }
  if (action === "emit") {
    return {
      kind: "emit",
      subject: requiredFlag(args, "subject", "Emit actions require --subject <subject>"),
      payload: stringFlag(args, "payload"),
    };
  }
  if (action === "hermes") {
    return {
      kind: "hermes",
      invoke: requiredFlag(args, "invoke", "Hermes actions require --invoke <name-or-url>"),
      payload: stringFlag(args, "payload"),
      timeout: stringFlag(args, "timeout"),
    };
  }
  if (action === "honeybee-flow" || (action === "honeybee" && stringFlag(args, "run") === "flow")) {
    return {
      kind: "honeybee",
      run: "flow",
      flow: requiredFlag(args, "flow", "Honeybee flow actions require --flow <name>"),
      args: keyValueRecord(flagValues(args, "arg")),
    };
  }
  if (action === "honeybee-loop" || (action === "honeybee" && stringFlag(args, "run") === "loop")) {
    return {
      kind: "honeybee",
      run: "loop",
      loop: keyValueJsonRecord(flagValues(args, "loop")),
    };
  }
  if (action === "honeybee-spawn" || (action === "honeybee" && stringFlag(args, "run") === "spawn")) {
    return {
      kind: "honeybee",
      run: "spawn",
      bee: requiredFlag(args, "bee", "Honeybee spawn actions require --bee <kind>"),
      name: stringFlag(args, "name"),
      colony: stringFlag(args, "colony"),
      home: stringFlag(args, "home"),
      cwd: stringFlag(args, "cwd"),
      yolo: args.flags.yolo === true ? true : args.flags["no-yolo"] === true ? false : undefined,
      acceptTrust: args.flags["accept-trust"] === true ? true : args.flags["no-accept-trust"] === true ? false : undefined,
      args: flagValues(args, "bee-arg"),
      message: stringFlag(args, "message") ?? stringFlag(args, "prompt"),
      timeout: stringFlag(args, "timeout"),
    };
  }
  if (action === "honeybee-send" || (action === "honeybee" && stringFlag(args, "run") === "send")) {
    return {
      kind: "honeybee",
      run: "send",
      target: requiredFlag(args, "target", "Honeybee send actions require --target <bee>"),
      message: requiredFlag(args, "message", "Honeybee send actions require --message <text>"),
      timeout: stringFlag(args, "timeout"),
    };
  }
  if (action === "honeybee-buz" || (action === "honeybee" && stringFlag(args, "run") === "buz")) {
    const tier = stringFlag(args, "tier");
    if (tier && tier !== "interrupt" && tier !== "queue" && tier !== "passive") throw new Error("--tier must be interrupt, queue, or passive");
    return {
      kind: "honeybee",
      run: "buz",
      target: requiredFlag(args, "target", "Honeybee buz actions require --target <bee>"),
      message: requiredFlag(args, "message", "Honeybee buz actions require --message <text>"),
      tier: tier as "interrupt" | "queue" | "passive" | undefined,
      subject: stringFlag(args, "subject"),
      senderHuman: stringFlag(args, "sender-human"),
      timeout: stringFlag(args, "timeout"),
    };
  }
  if (action === "honeybee-kill" || (action === "honeybee" && stringFlag(args, "run") === "kill")) {
    return {
      kind: "honeybee",
      run: "kill",
      target: requiredFlag(args, "target", "Honeybee kill actions require --target <bee>"),
      timeout: stringFlag(args, "timeout"),
    };
  }
  throw new Error("Create requires --action <command|http|emit|hermes|honeybee-flow|honeybee-loop|honeybee-spawn|honeybee-send|honeybee-buz|honeybee-kill> or --action-json");
}

function routerFromFlags(args: ParsedArgs): RouterConfig | undefined {
  return jsonFlag<RouterConfig>(args, "router-json");
}

function contextFromFlags(args: ParsedArgs): ContextResolver | undefined {
  const json = jsonFlag<ContextResolver>(args, "context-json");
  if (json) return json;
  const staticVars = keyValueRecord(flagValues(args, "static"));
  return staticVars ? { static: staticVars } : undefined;
}

function filterFromFlags(args: ParsedArgs): Filter | undefined {
  const json = jsonFlag<Filter>(args, "filter-json");
  if (json) return json;
  const values = keyValueJsonRecord(flagValues(args, "filter"));
  return Object.keys(values).length > 0 ? values : undefined;
}

function inferSourceKind(args: ParsedArgs): string {
  if (stringFlag(args, "every") || stringFlag(args, "cron") || stringFlag(args, "once")) return "schedule";
  if (stringFlag(args, "path")) return "webhook";
  if (stringFlag(args, "poll-interval")) return "poll";
  return "manual";
}

function jsonFlag<T>(args: ParsedArgs, key: string): T | undefined {
  const raw = stringFlag(args, key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Invalid JSON for --${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function keyValueRecord(values: string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  return Object.fromEntries(values.map((value) => splitKeyValue(value)));
}

function keyValueJsonRecord(values: string[]): Record<string, JsonValue> {
  return Object.fromEntries(values.map((value) => {
    const [key, raw] = splitKeyValue(value);
    return [key, parseScalar(raw)];
  }));
}

function splitKeyValue(value: string): [string, string] {
  const index = value.indexOf("=");
  if (index <= 0) throw new Error(`Expected key=value, got: ${value}`);
  return [value.slice(0, index), value.slice(index + 1)];
}

function parseScalar(value: string): JsonValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) return JSON.parse(value) as JsonValue;
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const rest: string[] = [];
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const [key, inline] = raw.split("=", 2);
      const value =
        inline ??
        optionalFlagValue(key, argv[index + 1], (value) => {
          index += 1;
          return value;
        }) ??
        flagValue(key, argv, () => {
          index += 1;
          return argv[index];
        });
      addFlag(flags, key, value);
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const key = token.slice(1);
      const value =
        optionalFlagValue(key, argv[index + 1], (value) => {
          index += 1;
          return value;
        }) ??
        flagValue(key, argv, () => {
          index += 1;
          return argv[index];
        });
      addFlag(flags, key, value);
      continue;
    }
    if (!command) command = token;
    else rest.push(token);
  }
  return { command, rest, flags, json: Boolean(flags.json) };
}

function optionalFlagValue(key: string, next: string | undefined, consume: (value: string) => string): string | boolean | undefined {
  if (key !== "once") return undefined;
  if (next === undefined || next.startsWith("-")) return true;
  return consume(next);
}

function flagValue(key: string, argv: string[], consume: () => string): string | boolean {
  const booleanFlags = new Set([
    "json",
    "enabled",
    "disabled",
    "dry-run",
    "follow",
    "foreground",
    "collect",
    "force",
    "install-webhook",
    "yolo",
    "no-yolo",
    "accept-trust",
    "no-accept-trust",
  ]);
  if (booleanFlags.has(key)) return true;
  const value = consume();
  if (value === undefined || value.startsWith("-")) throw new Error(`--${key} requires a value`);
  return value;
}

function addFlag(flags: Record<string, string | boolean | string[]>, key: string, value: string | boolean): void {
  if (flags[key] === undefined) {
    flags[key] = value;
    return;
  }
  const current = flags[key];
  flags[key] = Array.isArray(current) ? [...current, String(value)] : [String(current), String(value)];
}

function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  if (value === undefined || typeof value === "boolean") return undefined;
  return Array.isArray(value) ? String(value[value.length - 1]) : String(value);
}

function flagValues(args: ParsedArgs, key: string): string[] {
  const value = args.flags[key];
  if (value === undefined || typeof value === "boolean") return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function numberFlag(args: ParsedArgs, key: string): number | undefined {
  const value = stringFlag(args, key);
  if (!value) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${key} must be a number`);
  return number;
}

function requiredArg(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requiredFlag(args: ParsedArgs, key: string, message: string): string {
  return requiredArg(stringFlag(args, key), message);
}

function print(args: ParsedArgs, jsonValue: unknown, human: string): void {
  if (args.json) console.log(JSON.stringify(jsonValue, null, 2));
  else console.log(human);
}

async function readVersion(): Promise<string> {
  try {
    const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function helpSection(title: string, rows: Array<[string, string]>): string {
  const cmdWidth = Math.max(...rows.map(([cmd]) => cmd.length));
  const body = rows
    .map(([cmd, desc]) => `  ${c.accent(pad(cmd, cmdWidth))}   ${c.dim(desc)}`)
    .join("\n");
  return `${c.bold(title)}\n${body}`;
}

async function printHelp(): Promise<void> {
  const version = await readVersion();
  const out: string[] = [];
  out.push(banner(version));
  out.push("");
  out.push(c.dim("  Standalone trigger substrate for schedules, polls, webhooks, and fired actions."));
  out.push("");
  out.push(`${c.dim("Usage:")} ${c.bold("pol")} ${c.dim("<command> [args] [flags]")}   ${c.dim("(alias of")} ${c.bold("pollinate")}${c.dim(")")}`);
  out.push("");
  out.push(
    helpSection("Triggers", [
      ["add <file.toml>", "register a trigger from a TOML file"],
      ["create <id> …", "build a trigger from flags (see shortcuts)"],
      ["list, ls [--enabled|--disabled]", "list triggers, filter by --tag / --source"],
      ["get <id>", "show a trigger in detail"],
      ["enable / disable <id>", "toggle a trigger"],
      ["edit <id>", "open the trigger TOML in $EDITOR"],
      ["remove <id>", "delete a trigger"],
    ]),
  );
  out.push("");
  out.push(
    helpSection("Fire & inspect", [
      ["trigger <id> [--dry-run]", "fire now; --payload '{…}' to pass data"],
      ["jobs [--status <s>] [--last n]", "list recent jobs"],
      ["job <jobId> | job cancel <id>", "inspect or cancel a job"],
      ["bindings [--trigger <id>]", "list router subject→target bindings"],
      ["bindings get <id>", "inspect a router binding"],
      ["routers [list]", "list built-in and user-space router plugins"],
      ["routers init <name>", "create ~/.pollinate/router-plugins/<name>.mjs"],
      ["hooks", "list webhook endpoints"],
      ["hook create <id> [--ttl 10m]", "create a temporary webhook URL"],
      ["hook inbox [id]", "create a temporary emit-only webhook"],
      ["hook wait [id]", "wait for one one-shot webhook delivery"],
      ["hook gc", "remove expired or spent temporary hooks"],
      ["hook test <id> --payload …", "simulate a webhook delivery"],
      ["satellite run --target …", "relay public webhooks to a local daemon"],
      ["github create-pr-router <id>", "create a professional GitHub PR review router"],
      ["github install-pr-router <id>", "create or update the GitHub webhook"],
      ["status", "dashboard: triggers, jobs, upcoming fires"],
      ["ledger [-n <lines>] [--follow]", "stream the event ledger"],
    ]),
  );
  out.push("");
  out.push(
    helpSection("Daemon", [
      ["daemon install|uninstall", "manage the user service"],
      ["daemon start|stop|restart", "control the running service"],
      ["daemon status|logs", "inspect the service"],
      ["daemon run --foreground", "run the daemon in this shell"],
    ]),
  );
  out.push("");
  out.push(c.bold("Create shortcuts"));
  const shortcuts: Array<[string, string]> = [
    ["--source schedule", "--every 5m | --cron '0 8 * * 1-5' | --once <iso>"],
    ["--source webhook", "--path my-hook [--secret env:NAME] [--transform f='$.x']"],
    ["--source poll", "--poll-interval 30s (--fetch-command|--fetch-http|--fetch-file)"],
    ["--cwd <dir>", "default working directory for command-backed work"],
    ["--delivery", "immediate | throttled | batched | debounced"],
    ["--action command", "--command 'echo {{event}}'"],
    ["--action http", "--method POST --url https://… [--body '{{event}}']"],
    ["--action emit", "--subject some.event [--payload '{\"k\":\"{{var}}\"}']"],
    ["--action-json", "supports kind=sequence for serial/parallel action orchestration"],
    ["--router-json", "configure a router trigger from JSON"],
  ];
  const scWidth = Math.max(...shortcuts.map(([k]) => k.length));
  for (const [k, v] of shortcuts) out.push(`  ${c.cyan(pad(k, scWidth))}   ${c.dim(v)}`);
  out.push("");
  out.push(c.dim(`  ${sym.mid} --source-json / --delivery-json / --action-json / --router-json / --context-json / --filter-json for full control`));
  out.push(c.dim(`  ${sym.mid} add ${c.bold("--json")} to any command for machine-readable output`));
  out.push("");
  out.push(c.dim(`Examples:`));
  out.push(`  ${c.dim("$")} ${c.bold("pol create hourly --source schedule --every 1h --action command --command 'echo hi'")}`);
  out.push(`  ${c.dim("$")} ${c.bold("pol trigger hourly --dry-run")}`);
  out.push(`  ${c.dim("$")} ${c.bold("pol status")}`);
  console.log(out.join("\n"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    console.error(JSON.stringify({ error: message }));
  } else {
    const usage = message.startsWith("Usage:");
    console.error(usage ? c.dim(message) : say.fail(message));
    if (!usage) console.error(say.hint(`run ${c.bold("pol help")} for available commands`));
  }
  process.exitCode = 1;
});
