import { readdir, readFile, stat, unlink } from "node:fs/promises";
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
  routerBindingsDir,
  stateDir,
  storeRoot,
  triggerDir,
  withFileLock,
  writeJson,
} from "./fsx.js";
import { idFromPath, parseDaemonConfigToml, parseTriggerToml, triggerToToml } from "./config.js";
import type { CursorState, DaemonConfig, DeliveryState, Job, JobStatus, LedgerEvent, RouterBinding, ScheduleState, Trigger } from "./types.js";
import { nowIso, parseDuration } from "./time.js";
import { allocateJobIdentity, matchesJobReference, type JobIdentity } from "./job-ids.js";

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(["completed", "errored", "timed-out", "cancelled"]);

export type ArchiveJobsOptions = {
  /** Archive terminal jobs whose terminal timestamp is older than this duration (e.g. "7d"). */
  retention?: string;
  /** Pre-parsed override for `retention`, in milliseconds. */
  olderThanMs?: number;
  /** Keep at most this many of the most-recent jobs; archive terminal jobs beyond the cap. */
  maxJobs?: number;
  /** Count what would be archived without touching any files. */
  dryRun?: boolean;
  now?: number;
};

export type ArchiveJobsResult = {
  /** Number of job files moved into the archive (or that would be, when dryRun). */
  archived: number;
  /** Total job files inspected. */
  scanned: number;
};

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

  jobArchivePath(): string {
    // Lives under jobs/ but uses .jsonl so the readdir filters that pick up
    // per-job ".json" files never treat the archive as a live job.
    return join(jobsDir(this.root), "archive.jsonl");
  }

  routerBindingPath(triggerId: string, subjectKey: string): string {
    return join(routerBindingsDir(this.root), safePathPart(triggerId), `${safePathPart(subjectKey)}.json`);
  }

  routerBindingLockPath(triggerId: string, subjectKey: string): string {
    return join(routerBindingsDir(this.root), safePathPart(triggerId), `${safePathPart(subjectKey)}.lock`);
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

  async getRouterBinding(triggerId: string, subjectKey: string): Promise<RouterBinding | null> {
    return readJsonOr<RouterBinding | null>(this.routerBindingPath(triggerId, subjectKey), null);
  }

  async saveRouterBinding(binding: RouterBinding): Promise<void> {
    await this.ensure();
    await writeJson(this.routerBindingPath(binding.triggerId, binding.subjectKey), binding);
  }

  async withRouterBindingLock<T>(triggerId: string, subjectKey: string, fn: () => Promise<T>): Promise<T> {
    await this.ensure();
    return withFileLock(this.routerBindingLockPath(triggerId, subjectKey), fn);
  }

  async listRouterBindings(options: { triggerId?: string } = {}): Promise<RouterBinding[]> {
    await this.ensure();
    const root = routerBindingsDir(this.root);
    const triggerDirs = options.triggerId ? [safePathPart(options.triggerId)] : await readdir(root).catch(() => []);
    const bindings: RouterBinding[] = [];
    for (const triggerDirName of triggerDirs.sort()) {
      const dir = join(root, triggerDirName);
      const entries = await readdir(dir).catch(() => []);
      for (const entry of entries.filter((item) => item.endsWith(".json")).sort()) {
        const binding = await readJsonOr<RouterBinding | null>(join(dir, entry), null);
        if (binding && (!options.triggerId || binding.triggerId === options.triggerId)) bindings.push(binding);
      }
    }
    bindings.sort((a, b) => (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt));
    return bindings;
  }

  async allocateJobIdentity(trigger: Trigger): Promise<JobIdentity> {
    await this.ensure();
    return allocateJobIdentity({ root: this.root, trigger });
  }

  async getJob(id: string): Promise<Job | null> {
    const exact = await readJsonOr<Job | null>(this.jobPath(id), null);
    if (exact) return exact;
    const live = await this.resolveJobReference(id);
    if (live) return live;
    return this.findArchivedJob(id);
  }

  private async findArchivedJob(reference: string): Promise<Job | null> {
    const text = await readTextOrNull(this.jobArchivePath());
    if (!text) return null;
    const matches: Job[] = [];
    for (const line of text.split(/\n/)) {
      if (!line.trim()) continue;
      let job: Job;
      try {
        job = JSON.parse(line) as Job;
      } catch {
        continue;
      }
      if (matchesJobReference(job, reference)) matches.push(job);
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
    return matches[0];
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
    const dir = jobsDir(this.root);
    const names = await this.jobFileNamesByRecency(dir);
    // Parse lazily in recency order so a bounded `last` query never reads more
    // job files than it returns — the store may hold thousands of records.
    const jobs: Job[] = [];
    for (const name of names) {
      const job = await readJsonOr<Job | null>(join(dir, name), null);
      if (!job) continue;
      if (options.status && job.status !== options.status) continue;
      if (options.triggerId && job.triggerId !== options.triggerId) continue;
      jobs.push(job);
      if (options.last !== undefined && jobs.length >= options.last) break;
    }
    jobs.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
    return jobs;
  }

  /** Cheap count of live job files (no JSON parsing). */
  async countJobs(): Promise<number> {
    await this.ensure();
    const entries = await readdir(jobsDir(this.root)).catch(() => []);
    return entries.filter(isJobFile).length;
  }

  /**
   * Compacts terminal jobs that are older than the retention window — or beyond
   * the count cap — into `jobs/archive.jsonl` and removes their individual files,
   * so the live jobs directory (and every readdir over it) stays small. In-flight
   * jobs are never archived. The ledger already records job lifecycle events, and
   * `getJob` still resolves archived ids, so nothing observable is lost.
   */
  async archiveJobs(options: ArchiveJobsOptions = {}): Promise<ArchiveJobsResult> {
    await this.ensure();
    const dir = jobsDir(this.root);
    const now = options.now ?? Date.now();
    const retentionMs = options.olderThanMs ?? (options.retention !== undefined ? parseDuration(options.retention) : undefined);
    const entries = (await readdir(dir).catch(() => [])).filter(isJobFile);

    const records: Array<{ name: string; job: Job; terminal: boolean; sortKey: number }> = [];
    for (const name of entries) {
      const job = await readJsonOr<Job | null>(join(dir, name), null);
      if (!job) continue;
      const sortKey = new Date(job.completedAt ?? job.queuedAt).getTime();
      records.push({ name, job, terminal: TERMINAL_JOB_STATUSES.has(job.status), sortKey });
    }
    records.sort((a, b) => b.sortKey - a.sortKey);

    const doomed = records.filter((record, index) => {
      if (!record.terminal) return false;
      const tooOld = retentionMs !== undefined && now - record.sortKey >= retentionMs;
      const overCap = options.maxJobs !== undefined && index >= options.maxJobs;
      return tooOld || overCap;
    });

    if (!options.dryRun) {
      for (const record of doomed) {
        await appendJsonLine(this.jobArchivePath(), record.job);
        await unlink(join(dir, record.name)).catch(() => undefined);
      }
      if (doomed.length) {
        await this.appendLedger({ event: "pollinate.job.archived", count: doomed.length, scanned: records.length });
      }
    }
    return { archived: doomed.length, scanned: records.length };
  }

  private async jobFileNamesByRecency(dir: string): Promise<string[]> {
    const names = (await readdir(dir).catch(() => [])).filter(isJobFile);
    const stamped = await Promise.all(
      names.map(async (name) => ({ name, mtimeMs: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return stamped.map((entry) => entry.name);
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

function isJobFile(name: string): boolean {
  return name.endsWith(".json");
}

function safePathPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "binding";
}
