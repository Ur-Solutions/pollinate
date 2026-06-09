import type { Action, Activation, DryRunResult, ExecutionProfile, Job, JsonValue, SourceKind, Trigger } from "./types.js";
import { PollinateStore } from "./store.js";
import { resolveContext } from "./context.js";
import { renderAction, renderString } from "./templates.js";
import { execShell, shellQuote } from "./process.js";
import { nowIso, parseDuration } from "./time.js";
import { executeRouter } from "./router.js";

export type ActionExecutorOptions = {
  contextTimeoutMs: number;
  commandTimeoutMs: number;
  execution?: ExecutionProfile;
};

export type ActionResult = { timedOut?: boolean; [key: string]: unknown };

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

  private executeHoneybee(action: Extract<Action, { kind: "honeybee" }>, cwd?: string): Promise<ActionResult> {
    if (action.run === "flow") {
      const args = Object.entries(action.args ?? {}).flatMap(([key, value]) => ["--arg", `${key}=${value}`]);
      return execShell(["hive", "flow", "run", shellQuote(action.flow), ...args.map(shellQuote)].join(" "), {
        cwd,
        timeoutMs: this.options.commandTimeoutMs,
        execution: this.options.execution,
      }).then((result) => {
        if (result.exitCode !== 0) throw new Error(`hive flow run exited ${result.exitCode}: ${result.stderr.trim()}`);
        return { ...result };
      });
    }
    if (action.run === "loop") {
      const loop = cwd && !Object.prototype.hasOwnProperty.call(action.loop, "cwd") ? { ...action.loop, cwd } : action.loop;
      const flags = flagsFromRecord(loop);
      return execShell(["hive", "loop", "start", ...flags.map(shellQuote)].join(" "), {
        cwd,
        timeoutMs: this.options.commandTimeoutMs,
        execution: this.options.execution,
      }).then((result) => {
        if (result.exitCode !== 0) throw new Error(`hive loop start exited ${result.exitCode}: ${result.stderr.trim()}`);
        return { ...result };
      });
    }
    if (action.run === "spawn") {
      const spawnCwd = action.cwd ?? cwd;
      const flags = flagsFromRecord({
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
      return execShell(["hive", "spawn", shellQuote(action.bee), ...flags.map(shellQuote), ...beeArgs.map(shellQuote)].join(" "), {
        cwd: spawnCwd,
        timeoutMs,
        execution: this.options.execution,
      }).then(async (result) => {
        if (result.exitCode !== 0) throw new Error(`hive spawn exited ${result.exitCode}: ${result.stderr.trim()}`);
        const handle = parseHiveHandle(result.stdout) ?? action.name;
        if (!handle) throw new Error("hive spawn did not return a target handle");
        if (action.message) {
          const sent = await execShell(["hive", "send", shellQuote(handle), shellQuote(action.message)].join(" "), {
            cwd: spawnCwd,
            timeoutMs,
            execution: this.options.execution,
          });
          if (sent.exitCode !== 0) throw new Error(`hive send exited ${sent.exitCode}: ${sent.stderr.trim()}`);
          return { ...result, handle, sent };
        }
        return { ...result, handle };
      });
    }
    if (action.run === "send") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      return execShell(["hive", "send", shellQuote(action.target), shellQuote(action.message)].join(" "), {
        cwd,
        timeoutMs,
        execution: this.options.execution,
      }).then((result) => {
        if (result.exitCode !== 0) throw new Error(`hive send exited ${result.exitCode}: ${result.stderr.trim()}`);
        return { ...result };
      });
    }
    if (action.run === "buz") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      const command = [
        "hive",
        "buz",
        "send",
        shellQuote(action.target),
        "--sender-human",
        shellQuote(action.senderHuman ?? "pollinate"),
        "--tier",
        shellQuote(action.tier ?? "queue"),
        ...(action.subject ? ["--subject", shellQuote(action.subject)] : []),
        "-p",
        shellQuote(action.message),
      ].join(" ");
      return execShell(command, { cwd, timeoutMs, execution: this.options.execution }).then((result) => {
        if (result.exitCode !== 0) throw new Error(`hive buz send exited ${result.exitCode}: ${result.stderr.trim()}`);
        return { ...result };
      });
    }
    if (action.run === "kill") {
      const timeoutMs = parseDuration(action.timeout, this.options.commandTimeoutMs);
      return execShell(["hive", "kill", shellQuote(action.target)].join(" "), { cwd, timeoutMs, execution: this.options.execution }).then((result) => {
        if (result.exitCode !== 0) throw new Error(`hive kill exited ${result.exitCode}: ${result.stderr.trim()}`);
        return { ...result };
      });
    }
    const neverAction: never = action;
    throw new Error(`Unsupported honeybee action: ${JSON.stringify(neverAction)}`);
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
    return execShell(["hermes", shellQuote(action.invoke)].join(" "), { cwd, input: action.payload, timeoutMs, execution: this.options.execution }).then((result) => {
      if (result.exitCode !== 0) throw new Error(`hermes exited ${result.exitCode}: ${result.stderr.trim()}`);
      return { ...result };
    });
  }
}

function flagsFromRecord(record: Record<string, JsonValue | undefined>): string[] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
    if (typeof value === "boolean") return value ? [flag] : [];
    return [flag, String(value)];
  });
}

function parseHiveHandle(stdout: string): string | undefined {
  const line = stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (!line) return undefined;
  return line.split(/\s+/)[0];
}

export function sourceKindForTrigger(trigger: Trigger, fallback: SourceKind = "manual"): SourceKind {
  return trigger.source.kind === "manual" ? fallback : trigger.source.kind;
}
