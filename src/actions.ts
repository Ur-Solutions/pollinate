import type { Action, Activation, DryRunResult, ExecutionProfile, Job, JsonValue, SourceKind, Trigger } from "./types.js";
import { PollinateStore } from "./store.js";
import { resolveContext } from "./context.js";
import { renderAction, renderString } from "./templates.js";
import { execArgv, execShell, type ExecResult } from "./process.js";
import { nowIso, parseDuration } from "./time.js";
import { executeRouter } from "./router.js";

export type ActionExecutorOptions = {
  contextTimeoutMs: number;
  commandTimeoutMs: number;
  execution?: ExecutionProfile;
};

export type ActionResult = { timedOut?: boolean; handle?: string; handles?: Record<string, string>; [key: string]: unknown };

export class ActionExecutor {
  constructor(
    private readonly store: PollinateStore,
    private readonly options: ActionExecutorOptions,
  ) {}

  async createQueuedJob(trigger: Trigger, activation: Activation, batch: JsonValue[]): Promise<Job> {
    const identity = await this.store.allocateJobIdentity(trigger);
    return {
      id: identity.id,
      idPrefix: identity.idPrefix,
      uuid: identity.uuid,
      triggerId: trigger.id,
      source: activation.source,
      status: "queued",
      cwd: trigger.cwd,
      context: {},
      action: trigger.action,
      queuedAt: nowIso(),
      batch,
    };
  }

  async dryRun(trigger: Trigger, activation: Activation, batch: JsonValue[] = [activation.payload]): Promise<DryRunResult> {
    if (trigger.router && !trigger.action) {
      return {
        triggerId: trigger.id,
        cwd: trigger.cwd,
        context: {
          trigger_id: trigger.id,
          source_kind: activation.source,
          event: JSON.stringify(activation.payload),
          batch: JSON.stringify(batch),
          batch_count: String(batch.length),
        },
        action: trigger.router.onOpen,
        warnings: ["Router dry-run renders the configured onOpen action only; it does not normalize or route events."],
      };
    }
    const resolved = await this.buildContext(trigger, activation, batch, trigger.cwd);
    if (!trigger.action) throw new Error(`Trigger ${trigger.id} has no action`);
    const rendered = this.renderJobInputs(trigger.action, trigger.cwd, resolved.context);
    return {
      triggerId: trigger.id,
      cwd: rendered.cwd,
      context: resolved.context,
      action: rendered.action,
      warnings: [...resolved.warnings, ...rendered.warnings],
    };
  }

  async executeJob(job: Job, trigger: Trigger, activation: Activation, batch: JsonValue[]): Promise<Job> {
    const cancellation = await this.store.getJob(job.id);
    if (cancellation?.status === "cancelled") return cancellation;
    if (trigger.router && !job.action) return this.executeRouterJob(job, trigger, activation, batch);
    await this.store.updateJob(job.id, { status: "resolving-context" });
    const jobCwd = job.cwd ?? trigger.cwd;
    const resolved = await this.buildContext(trigger, activation, batch, jobCwd);
    if (!job.action) throw new Error(`Job ${job.id} has no action`);
    const rendered = this.renderJobInputs(job.action, jobCwd, resolved.context);
    const warnings = resolved.warnings.concat(rendered.warnings);
    const running = await this.store.updateJob(job.id, {
      status: "running",
      cwd: rendered.cwd,
      context: resolved.context,
      action: rendered.action,
      startedAt: nowIso(),
    });
    await this.store.appendLedger({ event: "pollinate.job.started", job_id: job.id, trigger_id: trigger.id, action_kind: rendered.action.kind, cwd: rendered.cwd });
    try {
      const result = await this.executeAction(rendered.action, rendered.cwd);
      const completed = await this.store.updateJob(job.id, {
        status: result.timedOut ? "timed-out" : "completed",
        result,
        completedAt: nowIso(),
        error: warnings.join("\n") || undefined,
      });
      await this.store.appendLedger({
        event: result.timedOut ? "pollinate.job.errored" : "pollinate.job.completed",
        job_id: job.id,
        trigger_id: trigger.id,
        duration_ms: running.startedAt ? Date.now() - new Date(running.startedAt).getTime() : undefined,
        warnings,
      });
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errored = await this.store.updateJob(job.id, { status: "errored", error: message, completedAt: nowIso() });
      await this.store.appendLedger({ event: "pollinate.job.errored", job_id: job.id, trigger_id: trigger.id, error: message });
      return errored;
    }
  }

  private async executeRouterJob(job: Job, trigger: Trigger, activation: Activation, batch: JsonValue[]): Promise<Job> {
    const running = await this.store.updateJob(job.id, {
      status: "running",
      cwd: job.cwd ?? trigger.cwd,
      context: {
        event: JSON.stringify(activation.payload),
        batch: JSON.stringify(batch),
        batch_count: String(batch.length),
      },
      startedAt: nowIso(),
    });
    await this.store.appendLedger({ event: "pollinate.job.started", job_id: job.id, trigger_id: trigger.id, action_kind: "router", cwd: running.cwd });
    try {
      const result = await executeRouter({
        store: this.store,
        executor: this,
        trigger,
        activation,
        cwd: running.cwd,
      });
      const completed = await this.store.updateJob(job.id, { status: "completed", result, completedAt: nowIso() });
      await this.store.appendLedger({
        event: "pollinate.job.completed",
        job_id: job.id,
        trigger_id: trigger.id,
        duration_ms: running.startedAt ? Date.now() - new Date(running.startedAt).getTime() : undefined,
        warnings: [],
      });
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errored = await this.store.updateJob(job.id, { status: "errored", error: message, completedAt: nowIso() });
      await this.store.appendLedger({ event: "pollinate.job.errored", job_id: job.id, trigger_id: trigger.id, error: message });
      return errored;
    }
  }

  private async buildContext(trigger: Trigger, activation: Activation, batch: JsonValue[], cwd?: string) {
    const resolved = await resolveContext(trigger, activation, { defaultTimeoutMs: this.options.contextTimeoutMs, cwd, execution: this.options.execution });
    return {
      context: {
        ...resolved.context,
        batch: JSON.stringify(batch),
        batch_count: String(batch.length),
      },
      warnings: resolved.warnings,
    };
  }

  private renderJobInputs(action: Action, cwd: string | undefined, context: Record<string, string>): { action: Action; cwd?: string; warnings: string[] } {
    const renderedAction = renderAction(action, context);
    const renderedCwd = cwd ? renderString(cwd, context) : { value: undefined, warnings: [] };
    return {
      action: renderedAction.value,
      cwd: renderedCwd.value,
      warnings: [...renderedAction.warnings, ...renderedCwd.warnings],
    };
  }

  async executeAction(action: Action, cwd?: string): Promise<ActionResult> {
    if (action.kind === "sequence") {
      return this.executeSequence(action, cwd);
    }
    if (action.kind === "command") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      const result = await execShell(action.command, { cwd: action.cwd ?? cwd, timeoutMs, execution: this.options.execution });
      if (result.timedOut) return { ...result, timedOut: true };
      if (result.exitCode !== 0) throw new Error(`command exited ${result.exitCode}: ${result.stderr.trim()}`);
      return { ...result };
    }
    if (action.kind === "http") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(action.url, {
          method: action.method,
          headers: action.headers,
          body: action.body,
          signal: controller.signal,
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
        return { status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    }
    if (action.kind === "honeybee") {
      return this.executeHoneybee(action, cwd);
    }
    if (action.kind === "hermes") {
      return this.executeHermes(action, cwd);
    }
    if (action.kind === "emit") {
      let payload: JsonValue | string | undefined = action.payload;
      if (action.payload) {
        try {
          payload = JSON.parse(action.payload) as JsonValue;
        } catch {
          payload = action.payload;
        }
      }
      await this.store.appendLedger({ event: "pollinate.emit", subject: action.subject, payload });
      return { subject: action.subject, payload };
    }
    const neverAction: never = action;
    throw new Error(`Unsupported action: ${JSON.stringify(neverAction)}`);
  }

  private async executeSequence(action: Extract<Action, { kind: "sequence" }>, cwd?: string): Promise<ActionResult> {
    const continueOnError = action.continueOnError === true;
    const runStep = async (step: (typeof action.actions)[number], index: number) => {
      const id = step.id ?? String(index + 1);
      try {
        const result = await this.executeAction(step.action, cwd);
        return { id, action: step.action.kind, result };
      } catch (error) {
        if (!continueOnError) throw error;
        return { id, action: step.action.kind, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const results =
      action.mode === "parallel"
        ? await Promise.all(action.actions.map((step, index) => runStep(step, index)))
        : await runSequence(action.actions, runStep);
    const handles: Record<string, string> = {};
    for (const step of results) {
      const result = "result" in step ? step.result : undefined;
      if (!result) continue;
      if (typeof result.handle === "string") handles[step.id] = result.handle;
      if (result.handles) {
        for (const [key, value] of Object.entries(result.handles)) handles[key] = value;
      }
    }
    const handle = (action.primary ? handles[action.primary] : undefined) ?? Object.values(handles)[0];
    return {
      results,
      ...(Object.keys(handles).length ? { handles } : {}),
      ...(handle ? { handle } : {}),
    };
  }

  private executeHoneybee(action: Extract<Action, { kind: "honeybee" }>, cwd?: string): Promise<ActionResult> {
    if (action.run === "flow") {
      const args = Object.entries(action.args ?? {}).flatMap(([key, value]) => ["--arg", `${key}=${value}`]);
      return this.execHive(["flow", "run", action.flow, ...args], "hive flow run", { cwd });
    }
    if (action.run === "loop") {
      const loop = cwd && !Object.prototype.hasOwnProperty.call(action.loop, "cwd") ? { ...action.loop, cwd } : action.loop;
      return this.execHive(["loop", "start", ...flagsFromRecord(loop)], "hive loop start", { cwd });
    }
    if (action.run === "spawn") {
      const spawnCwd = action.cwd ?? cwd;
      const flags = flagsFromRecord({
        ...(action.account ? { account: action.account } : {}),
        ...(action.name ? { name: action.name } : {}),
        ...(action.colony ? { colony: action.colony } : {}),
        ...(action.home ? { home: action.home } : {}),
        ...(spawnCwd ? { cwd: spawnCwd } : {}),
        ...(action.yolo === true ? { yolo: true } : {}),
      });
      if (action.yolo === false) flags.push("--no-yolo");
      if (action.acceptTrust === false) flags.push("--no-accept-trust");
      const beeArgs = action.args?.length ? ["--", ...action.args] : [];
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      return this.execHive(["spawn", action.bee, ...flags, ...beeArgs], "hive spawn", { cwd: spawnCwd, timeoutMs }).then(async (result) => {
        const handle = parseHiveHandle(result.stdout) ?? (isValidHiveHandle(action.name) ? action.name : undefined);
        if (!handle) {
          throw new Error(`hive spawn did not return a parsable target handle; stdout: ${JSON.stringify(String(result.stdout).slice(0, 200))}`);
        }
        if (action.message) {
          const sent = await this.execHive(["send", handle, action.message], "hive send", { cwd: spawnCwd, timeoutMs });
          return { ...result, handle, sent };
        }
        return { ...result, handle };
      });
    }
    if (action.run === "send") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      return this.execHive(["send", action.target, action.message], "hive send", { cwd, timeoutMs });
    }
    if (action.run === "buz") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      const args = [
        "buz",
        "send",
        action.target,
        "--sender-human",
        action.senderHuman ?? "pollinate",
        "--tier",
        action.tier ?? "queue",
        ...(action.subject ? ["--subject", action.subject] : []),
        "-p",
        action.message,
      ];
      return this.execHive(args, "hive buz send", { cwd, timeoutMs });
    }
    if (action.run === "kill") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      return this.execHive(["kill", action.target], "hive kill", { cwd, timeoutMs });
    }
    const neverAction: never = action;
    throw new Error(`Unsupported honeybee action: ${JSON.stringify(neverAction)}`);
  }

  private async execHive(args: string[], label: string, options: { cwd?: string; timeoutMs?: number }): Promise<ActionResult & ExecResult> {
    const result = await execArgv("hive", args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.options.commandTimeoutMs,
      execution: this.options.execution,
    });
    if (result.exitCode !== 0) throw new Error(`${label} exited ${result.exitCode}: ${result.stderr.trim()}`);
    return { ...result };
  }

  private executeHermes(action: Extract<Action, { kind: "hermes" }>, cwd?: string): Promise<ActionResult> {
    if (/^https?:\/\//.test(action.invoke)) {
      return this.executeAction({
        kind: "http",
        method: "POST",
        url: action.invoke,
        headers: { "content-type": "application/json" },
        body: action.payload ?? "{}",
        timeout: action.timeout,
      }, cwd);
    }
    const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
    return execArgv("hermes", [action.invoke], { cwd, input: action.payload, timeoutMs, execution: this.options.execution }).then((result) => {
      if (result.exitCode !== 0) throw new Error(`hermes exited ${result.exitCode}: ${result.stderr.trim()}`);
      return { ...result };
    });
  }
}

async function runSequence<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += 1) out.push(await fn(items[index]!, index));
  return out;
}

function flagsFromRecord(record: Record<string, JsonValue | undefined>): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
    if (typeof value === "boolean") return value ? [flag] : [];
    return [flag, String(value)];
  });
}

const HIVE_HANDLE_RE = /^[A-Za-z0-9._:-]+$/;

export function isValidHiveHandle(value: string | undefined): value is string {
  // The trailing-colon exclusion skips prefix lines like "warning:" or "Error:".
  return Boolean(value && HIVE_HANDLE_RE.test(value) && !value.endsWith(":"));
}

export function parseHiveHandle(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0];
    if (isValidHiveHandle(token)) return token;
  }
  return undefined;
}

export function sourceKindForTrigger(trigger: Trigger, fallback: SourceKind = "manual"): SourceKind {
  return trigger.source.kind === "manual" ? fallback : trigger.source.kind;
}
