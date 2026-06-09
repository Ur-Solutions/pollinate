import { ActionExecutor } from "./actions.js";
import { DeliveryManager } from "./delivery.js";
import { PollEngine } from "./poll.js";
import { ScheduleEngine } from "./schedule.js";
import { PollinateStore } from "./store.js";
import { WebhookServer } from "./webhook.js";
import { parseDuration } from "./time.js";

export class PollinateDaemon {
  private delivery?: DeliveryManager;
  private schedule?: ScheduleEngine;
  private poll?: PollEngine;
  private webhook?: WebhookServer;
  private reloadTimer?: NodeJS.Timeout;
  private triggerSignature = "";
  private stopping = false;

  constructor(private readonly store = new PollinateStore()) {}

  async start(): Promise<void> {
    await this.store.ensure();
    const config = await this.store.daemonConfig();
    const triggers = await this.store.loadTriggers();
    const executor = new ActionExecutor(this.store, {
      contextTimeoutMs: parseDuration(config.defaults.contextTimeout, 5_000),
      commandTimeoutMs: parseDuration(config.defaults.commandTimeout, 600_000),
    });
    this.delivery = new DeliveryManager(this.store, executor);
    await this.delivery.init(triggers);
    this.schedule = new ScheduleEngine(this.store, this.delivery, triggers, config.defaults.tickMs);
    this.poll = new PollEngine(this.store, this.delivery, triggers);
    this.webhook = new WebhookServer(this.store, this.delivery, triggers, config.webhook.bind, config.webhook.port);
    await this.schedule.start();
    await this.poll.start();
    await this.webhook.start();
    this.triggerSignature = signatureForTriggers(triggers);
    this.reloadTimer = setInterval(() => {
      void this.reloadTriggers();
    }, config.defaults.triggerReloadMs);
    await this.store.appendLedger({ event: "pollinate.daemon.started", trigger_count: triggers.length, webhook_bind: config.webhook.bind, webhook_port: config.webhook.port });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    await this.webhook?.stop();
    await this.poll?.stop();
    await this.schedule?.stop();
    await this.delivery?.shutdown();
    await this.store.appendLedger({ event: "pollinate.daemon.stopped" });
  }

  private async reloadTriggers(): Promise<void> {
    if (this.stopping || !this.delivery || !this.schedule || !this.poll || !this.webhook) return;
    try {
      const triggers = await this.store.loadTriggers();
      const signature = signatureForTriggers(triggers);
      if (signature === this.triggerSignature) return;
      this.triggerSignature = signature;
      await this.delivery.init(triggers);
      this.schedule.updateTriggers(triggers);
      this.poll.updateTriggers(triggers);
      this.webhook.updateTriggers(triggers);
      await this.store.appendLedger({ event: "pollinate.daemon.triggers_reloaded", trigger_count: triggers.length });
    } catch (error) {
      await this.store.appendLedger({
        event: "pollinate.daemon.reload_errored",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function signatureForTriggers(triggers: Array<{ id: string; updatedAt: string; enabled: boolean }>): string {
  return triggers
    .map((trigger) => `${trigger.id}:${trigger.updatedAt}:${trigger.enabled}`)
    .sort()
    .join("|");
}

export async function runForeground(): Promise<void> {
  const daemon = new PollinateDaemon();
  await daemon.start();
  const stop = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await new Promise<void>(() => undefined);
}
