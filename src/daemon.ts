import { ActionExecutor } from "./actions.js";
import { DeliveryManager } from "./delivery.js";
import { PollEngine } from "./poll.js";
import { ScheduleEngine } from "./schedule.js";
import { PollinateStore } from "./store.js";
import { WebhookServer } from "./webhook.js";
import { nowIso, parseDuration } from "./time.js";
import { appendTextLine, daemonLogPath } from "./fsx.js";
import { gcTemporaryHooks } from "./hooks.js";
import { gcRouterBindings, routerGcSummary } from "./router-gc.js";
import type { DaemonConfig, JobStatus, Trigger } from "./types.js";

const STALE_JOB_RECOVERY_MS = 60_000;
const TERMINAL_JOB_STATUSES = new Set<JobStatus>(["completed", "errored", "timed-out", "cancelled"]);
let daemonProcessGuardsInstalled = false;

export class PollinateDaemon {
  private delivery?: DeliveryManager;
  private schedule?: ScheduleEngine;
  private poll?: PollEngine;
  private webhook?: WebhookServer;
  private executor?: ActionExecutor;
  private config?: DaemonConfig;
  private triggers: Trigger[] = [];
  private reloadTimer?: NodeJS.Timeout;
  private bindingGcTimer?: NodeJS.Timeout;
  private bindingGcRunning = false;
  private triggerSignature = "";
  private stopping = false;
  private daemonConfigSignature = "";

  constructor(private readonly store = new PollinateStore()) {}

  async start(): Promise<void> {
    await this.store.ensure();
    const recoveredJobs = await this.recoverStaleJobs();
    const config = await this.store.daemonConfig();
    await gcTemporaryHooks(this.store);
    const triggers = await this.store.loadTriggers();
    const executor = new ActionExecutor(this.store, {
      contextTimeoutMs: parseDuration(config.defaults.contextTimeout, 5_000),
      commandTimeoutMs: parseDuration(config.defaults.commandTimeout, 600_000),
      execution: config.execution,
    });
    this.config = config;
    this.daemonConfigSignature = signatureForConfig(config);
    this.executor = executor;
    this.triggers = triggers;
    this.delivery = new DeliveryManager(this.store, executor);
    await this.delivery.init(triggers);
    this.schedule = new ScheduleEngine(this.store, this.delivery, triggers, config.defaults.tickMs);
    this.poll = new PollEngine(this.store, this.delivery, triggers, config.execution);
    this.webhook = new WebhookServer(this.store, this.delivery, triggers, config.webhook.bind, config.webhook.port, config.webhook.relay);
    await this.schedule.start();
    await this.poll.start();
    await this.webhook.start();
    this.triggerSignature = signatureForTriggers(triggers);
    this.reloadTimer = setInterval(() => {
      void this.reloadTriggers();
    }, config.defaults.triggerReloadMs);
    this.bindingGcTimer = setInterval(() => {
      void this.runBindingGc();
    }, config.defaults.bindingGcMs);
    await this.store.appendLedger({
      event: "pollinate.daemon.started",
      trigger_count: triggers.length,
      webhook_bind: config.webhook.bind,
      webhook_port: config.webhook.port,
      webhook_relay_enabled: Boolean(config.webhook.relay.secret),
      recovered_jobs: recoveredJobs,
    });
    await this.log(
      `daemon started: ${triggers.length} triggers, webhook ${config.webhook.bind}:${config.webhook.port}, binding gc every ${config.defaults.bindingGcMs}ms${
        recoveredJobs ? `, recovered ${recoveredJobs} stale jobs` : ""
      }`,
    );
    void this.runBindingGc();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.bindingGcTimer) clearInterval(this.bindingGcTimer);
    await this.webhook?.stop();
    await this.poll?.stop();
    await this.schedule?.stop();
    await this.delivery?.shutdown();
    await this.store.appendLedger({ event: "pollinate.daemon.stopped" });
    await this.log("daemon stopped");
  }

  private async reloadTriggers(): Promise<void> {
    if (this.stopping || !this.delivery || !this.schedule || !this.poll || !this.webhook) return;
    try {
      const config = await this.store.daemonConfig();
      const configSignature = signatureForConfig(config);
      if (configSignature !== this.daemonConfigSignature) {
        this.daemonConfigSignature = configSignature;
        await this.log("pollinate.toml changed; restart the daemon to apply webhook, defaults, relay, or execution-profile changes");
      }
      await gcTemporaryHooks(this.store);
      const triggers = await this.store.loadTriggers();
      const signature = signatureForTriggers(triggers);
      if (signature === this.triggerSignature) return;
      this.triggerSignature = signature;
      this.triggers = triggers;
      await this.delivery.init(triggers);
      this.schedule.updateTriggers(triggers);
      this.poll.updateTriggers(triggers);
      this.webhook.updateTriggers(triggers);
      await this.store.appendLedger({ event: "pollinate.daemon.triggers_reloaded", trigger_count: triggers.length });
      await this.log(`triggers reloaded: ${triggers.length} active definitions`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.appendLedger({
        event: "pollinate.daemon.reload_errored",
        error: message,
      });
      await this.log(`trigger reload failed: ${message}`);
    }
  }

  private async runBindingGc(): Promise<void> {
    if (this.stopping || this.bindingGcRunning || !this.executor) return;
    this.bindingGcRunning = true;
    try {
      const result = await gcRouterBindings({
        store: this.store,
        executor: this.executor,
        triggers: this.triggers,
        execution: this.config?.execution,
      });
      const summary = routerGcSummary(result);
      if (summary) {
        await this.store.appendLedger({
          event: "pollinate.router.gc",
          expired: result.expired,
          reconciled: result.reconciled,
          retried: result.retried,
          retry_failed: result.retryFailed,
          abandoned: result.abandoned,
          staled: result.staled,
          errors: result.errors,
        });
        await this.log(`binding gc: ${summary}`);
      }
    } catch (error) {
      await this.log(`binding gc failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.bindingGcRunning = false;
    }
  }

  private async log(message: string): Promise<void> {
    try {
      await appendTextLine(daemonLogPath(this.store.root), `${nowIso()} ${message}`);
    } catch {
      // Logging must never take the daemon down.
    }
  }

  async logProcessGuard(message: string): Promise<void> {
    await this.log(`process guard: ${message}`);
  }

  private async recoverStaleJobs(now = Date.now(), staleMs = STALE_JOB_RECOVERY_MS): Promise<number> {
    const jobs = await this.store.listJobs();
    let recovered = 0;
    for (const job of jobs) {
      if (TERMINAL_JOB_STATUSES.has(job.status)) continue;
      const touchedAt = job.startedAt ?? job.queuedAt;
      const touchedMs = new Date(touchedAt).getTime();
      if (Number.isFinite(touchedMs) && now - touchedMs < staleMs) continue;
      const previousStatus = job.status;
      const error = `daemon restarted mid-execution; marking stale ${previousStatus} job errored`;
      await this.store.updateJob(job.id, {
        status: "errored",
        error,
        completedAt: nowIso(),
      });
      await this.store.appendLedger({
        event: "pollinate.job.errored",
        job_id: job.id,
        trigger_id: job.triggerId,
        error,
        recovered_from: previousStatus,
      });
      recovered += 1;
    }
    if (recovered > 0) await this.log(`recovered ${recovered} stale non-terminal jobs`);
    return recovered;
  }
}

function signatureForTriggers(triggers: Array<{ id: string; updatedAt: string; enabled: boolean }>): string {
  return triggers
    .map((trigger) => `${trigger.id}:${trigger.updatedAt}:${trigger.enabled}`)
    .sort()
    .join("|");
}

function signatureForConfig(config: DaemonConfig): string {
  return JSON.stringify(config);
}

export async function runForeground(): Promise<void> {
  const daemon = new PollinateDaemon();
  installDaemonProcessGuards((message) => daemon.logProcessGuard(message));
  await daemon.start();
  const stop = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await new Promise<void>(() => undefined);
}

function installDaemonProcessGuards(log: (message: string) => Promise<void>): void {
  if (daemonProcessGuardsInstalled) return;
  daemonProcessGuardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const message = `unhandled rejection: ${formatUnknownError(reason)}`;
    console.error(`pollinate daemon ${message}`);
    void log(message).catch(() => undefined);
  });
  process.on("uncaughtException", (error) => {
    const message = `uncaught exception: ${formatUnknownError(error)}`;
    console.error(`pollinate daemon ${message}`);
    void log(message).catch(() => undefined);
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
