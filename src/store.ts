import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  appendJsonLine,
  atomicWriteFile,
  daemonConfigPath,
  ensureStore,
  jobsDir,
  ledgerPath,
  readJsonOr,
  readTextOrNull,
  stateDir,
  storeRoot,
  triggerDir,
  writeJson,
} from "./fsx.js";
import { idFromPath, parseDaemonConfigToml, parseTriggerToml, triggerToToml } from "./config.js";
import type { CursorState, DaemonConfig, DeliveryState, Job, JobStatus, LedgerEvent, ScheduleState, Trigger } from "./types.js";
import { nowIso } from "./time.js";
import { allocateJobIdentity, matchesJobReference, type JobIdentity } from "./job-ids.js";

export class PollinateStore {
  readonly root: string;

  constructor(root = storeRoot()) {
    this.root = root;
  }

  async ensure(): Promise<void> {
    await ensureStore(this.root);
  }

  triggerPath(id: string): string {
    return join(triggerDir(this.root), `${id}.toml`);
  }

  jobPath(id: string): string {
    return join(jobsDir(this.root), `${id}.json`);
  }

  scheduleStatePath(): string {
    return join(stateDir(this.root), "schedule-state.json");
  }

  deliveryStatePath(): string {
    return join(stateDir(this.root), "delivery-state.json");
  }

  cursorStatePath(): string {
    return join(stateDir(this.root), "cursors.json");
  }

  async daemonConfig(): Promise<DaemonConfig> {
    return parseDaemonConfigToml(await readTextOrNull(daemonConfigPath(this.root)));
  }

  async loadTriggers(): Promise<Trigger[]> {
    await this.ensure();
    const entries = await readdir(triggerDir(this.root)).catch(() => []);
    const triggers: Trigger[] = [];
    for (const entry of entries.filter((item) => item.endsWith(".toml")).sort()) {
      const path = join(triggerDir(this.root), entry);
      const text = await readFile(path, "utf8");
      triggers.push(parseTriggerToml(text, idFromPath(path)));
    }
    return triggers;
  }

  async getTrigger(id: string): Promise<Trigger | null> {
    const text = await readTextOrNull(this.triggerPath(id));
    if (text === null) return null;
    return parseTriggerToml(text, id);
  }

  async saveTrigger(trigger: Trigger): Promise<void> {
    await this.ensure();
    await atomicWriteFile(this.triggerPath(trigger.id), triggerToToml({ ...trigger, updatedAt: nowIso() }), { mode: 0o600 });
  }

  async addTriggerFromToml(text: string, fallbackId?: string): Promise<Trigger> {
    const trigger = parseTriggerToml(text, fallbackId);
    await this.saveTrigger(trigger);
    await this.appendLedger({ event: "pollinate.trigger.added", trigger_id: trigger.id });
    return trigger;
  }

  async setTriggerEnabled(id: string, enabled: boolean): Promise<Trigger> {
    const trigger = await this.requireTrigger(id);
    const updated = { ...trigger, enabled, updatedAt: nowIso() };
    await this.saveTrigger(updated);
    await this.appendLedger({ event: enabled ? "pollinate.trigger.enabled" : "pollinate.trigger.disabled", trigger_id: id });
    return updated;
  }

  async removeTrigger(id: string): Promise<void> {
    await unlink(this.triggerPath(id));
    await this.appendLedger({ event: "pollinate.trigger.removed", trigger_id: id });
  }

  async requireTrigger(id: string): Promise<Trigger> {
    const trigger = await this.getTrigger(id);
    if (!trigger) throw new Error(`No trigger found with id "${id}"`);
    return trigger;
  }

  async readScheduleState(): Promise<ScheduleState> {
    return readJsonOr<ScheduleState>(this.scheduleStatePath(), {});
  }

  async writeScheduleState(state: ScheduleState): Promise<void> {
    await writeJson(this.scheduleStatePath(), state);
  }

  async readDeliveryState(): Promise<DeliveryState> {
    return readJsonOr<DeliveryState>(this.deliveryStatePath(), {});
  }

  async writeDeliveryState(state: DeliveryState): Promise<void> {
    await writeJson(this.deliveryStatePath(), state);
  }

  async readCursorState(): Promise<CursorState> {
    return readJsonOr<CursorState>(this.cursorStatePath(), {});
  }

  async writeCursorState(state: CursorState): Promise<void> {
    await writeJson(this.cursorStatePath(), state);
  }

  async saveJob(job: Job): Promise<void> {
    await this.ensure();
    await writeJson(this.jobPath(job.id), job);
  }

  async allocateJobIdentity(trigger: Trigger): Promise<JobIdentity> {
    await this.ensure();
    return allocateJobIdentity({ root: this.root, trigger });
  }

  async getJob(id: string): Promise<Job | null> {
    const exact = await readJsonOr<Job | null>(this.jobPath(id), null);
    if (exact) return exact;
    return this.resolveJobReference(id);
  }

  async updateJob(id: string, patch: Partial<Job>): Promise<Job> {
    const current = await this.getJob(id);
    if (!current) throw new Error(`No job found with id "${id}"`);
    const updated = { ...current, ...patch };
    await this.saveJob(updated);
    return updated;
  }

  async listJobs(options: { status?: JobStatus; triggerId?: string; last?: number } = {}): Promise<Job[]> {
    await this.ensure();
    const entries = await readdir(jobsDir(this.root)).catch(() => []);
    const jobs: Job[] = [];
    for (const entry of entries.filter((item) => item.endsWith(".json"))) {
      const job = await readJsonOr<Job | null>(join(jobsDir(this.root), entry), null);
      if (job) jobs.push(job);
    }
    jobs.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
    const filtered = jobs.filter((job) => {
      if (options.status && job.status !== options.status) return false;
      if (options.triggerId && job.triggerId !== options.triggerId) return false;
      return true;
    });
    return options.last ? filtered.slice(0, options.last) : filtered;
  }

  async cancelJob(id: string): Promise<Job> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`No job found with id "${id}"`);
    if (job.status === "completed" || job.status === "errored" || job.status === "timed-out") return job;
    const updated = {
      ...job,
      status: "cancelled" as const,
      completedAt: nowIso(),
      error: job.status === "running" ? "Cancellation requested after process start" : "Cancelled before start",
    };
    await this.saveJob(updated);
    await this.appendLedger({ event: "pollinate.job.cancelled", job_id: job.id, trigger_id: job.triggerId });
    return updated;
  }

  private async resolveJobReference(reference: string): Promise<Job | null> {
    await this.ensure();
    const entries = await readdir(jobsDir(this.root)).catch(() => []);
    const matches: Job[] = [];
    for (const entry of entries.filter((item) => item.endsWith(".json"))) {
      const job = await readJsonOr<Job | null>(join(jobsDir(this.root), entry), null);
      if (job && matchesJobReference(job, reference)) matches.push(job);
    }
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    const ids = matches.map((job) => job.id).sort().join(", ");
    throw new Error(`Job reference "${reference}" is ambiguous: ${ids}`);
  }

  async appendLedger(event: LedgerEvent): Promise<void> {
    await appendJsonLine(ledgerPath(this.root), { ts: nowIso(), ...event });
  }

  async readLedger(lines?: number): Promise<string[]> {
    const text = await readTextOrNull(ledgerPath(this.root));
    if (!text) return [];
    const all = text.split(/\n/).filter(Boolean);
    return lines ? all.slice(-lines) : all;
  }
}
