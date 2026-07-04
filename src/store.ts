import { createHash } from "node:crypto";
import { open, readdir, readFile, stat, unlink } from "node:fs/promises";
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
import { nowIso } from "./time.js";
import { allocateJobIdentity, matchesJobReference, pruneJobIdIndex, type JobIdentity } from "./job-ids.js";

export type JobRetentionOptions = {
  /** Required opt-in retention window; terminal jobs newer than this are never deleted. */
  terminalOlderThanDays: number;
  /** Optional safety floor that keeps the newest N terminal jobs per trigger even when older than the window. */
  keepLastPerTrigger?: number;
  now?: Date;
};

export type JobRetentionResult = {
  cutoff: string;
  deleted: number;
  kept: number;
  prunedJobUuids: number;
  deletedJobIds: string[];
};

type LedgerCache = {
  path: string;
  size: number;
  lines: string[];
  partial: string;
};

export class PollinateStore {
  readonly root: string;
  private ledgerCache?: LedgerCache;

  constructor(root = storeRoot()) {
    this.root = root;
  }

  async ensure(): Promise<void> {
    await ensureStore(this.root);
  }

  triggerPath(id: string): string {
    return join(triggerDir(this.root), `${assertStoreId("trigger", id)}.toml`);
  }

  jobPath(id: string): string {
    return join(jobsDir(this.root), `${assertStoreId("job", id)}.json`);
  }

  triggerLockPath(id: string): string {
    return join(stateDir(this.root), "trigger-locks", `${assertStoreId("trigger", id)}.lock`);
  }

  jobLockPath(id: string): string {
    return join(stateDir(this.root), "job-locks", `${assertStoreId("job", id)}.lock`);
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

  private async readStoredTrigger(path: string): Promise<Trigger> {
    const fileId = idFromPath(path);
    assertStoreId("trigger", fileId);
    const text = await readFile(path, "utf8");
    const parsed = parseTriggerToml(text, fileId);
    if (parsed.id !== fileId) {
      console.warn(`[pollinate] Trigger id "${parsed.id}" in ${path} does not match filename id "${fileId}"; using filename id`);
      return { ...parsed, id: fileId };
    }
    return parsed;
  }

  private async getTriggerUnlocked(id: string): Promise<Trigger | null> {
    const path = this.triggerPath(id);
    const text = await readTextOrNull(path);
    if (text === null) return null;
    const parsed = parseTriggerToml(text, id);
    if (parsed.id !== id) {
      console.warn(`[pollinate] Trigger id "${parsed.id}" in ${path} does not match filename id "${id}"; using filename id`);
      return { ...parsed, id };
    }
    return parsed;
  }

  private async writeTriggerUnlocked(trigger: Trigger): Promise<void> {
    await atomicWriteFile(this.triggerPath(trigger.id), triggerToToml({ ...trigger, updatedAt: nowIso() }), { mode: 0o600, sync: true });
  }

  private async mutateTrigger(id: string, mutate: (trigger: Trigger) => Trigger): Promise<Trigger> {
    await this.ensure();
    return withFileLock(this.triggerLockPath(id), async () => {
      const current = await this.getTriggerUnlocked(id);
      if (!current) throw new Error(`No trigger found with id "${id}"`);
      const updated = { ...mutate(current), updatedAt: nowIso() };
      await this.writeTriggerUnlocked(updated);
      return updated;
    });
  }

  async loadTriggers(): Promise<Trigger[]> {
    await this.ensure();
    const entries = await readdir(triggerDir(this.root)).catch(() => []);
    const triggers: Trigger[] = [];
    const seen = new Set<string>();
    for (const entry of entries.filter((item) => item.endsWith(".toml")).sort()) {
      const path = join(triggerDir(this.root), entry);
      try {
        const trigger = await this.readStoredTrigger(path);
        if (seen.has(trigger.id)) {
          console.warn(`[pollinate] Skipping duplicate trigger id "${trigger.id}" from ${path}`);
          continue;
        }
        seen.add(trigger.id);
        triggers.push(trigger);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pollinate] Skipping trigger file ${path}: ${message}`);
      }
    }
    return triggers;
  }

  async getTrigger(id: string): Promise<Trigger | null> {
    return this.getTriggerUnlocked(id);
  }

  async saveTrigger(trigger: Trigger): Promise<void> {
    await this.ensure();
    assertStoreId("trigger", trigger.id);
    await withFileLock(this.triggerLockPath(trigger.id), async () => {
      const current = await this.getTriggerUnlocked(trigger.id);
      const updated = prepareTriggerForSave(trigger, current);
      Object.assign(trigger, updated);
      await this.writeTriggerUnlocked(updated);
    });
  }

  async addTriggerFromToml(text: string, fallbackId?: string): Promise<Trigger> {
    const trigger = parseTriggerToml(text, fallbackId);
    await this.saveTrigger(trigger);
    await this.appendLedger({ event: "pollinate.trigger.added", trigger_id: trigger.id });
    return trigger;
  }

  async setTriggerEnabled(id: string, enabled: boolean): Promise<Trigger> {
    const updated = await this.mutateTrigger(id, (trigger) => ({ ...trigger, enabled }));
    await this.appendLedger({ event: enabled ? "pollinate.trigger.enabled" : "pollinate.trigger.disabled", trigger_id: id });
    return updated;
  }

  async removeTrigger(id: string): Promise<void> {
    await this.ensure();
    await withFileLock(this.triggerLockPath(id), async () => {
      await unlink(this.triggerPath(id));
    });
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
    await writeJson(this.deliveryStatePath(), state, { sync: false });
  }

  async readCursorState(): Promise<CursorState> {
    return readJsonOr<CursorState>(this.cursorStatePath(), {});
  }

  async writeCursorState(state: CursorState): Promise<void> {
    await writeJson(this.cursorStatePath(), state);
  }

  async saveJob(job: Job): Promise<void> {
    await this.ensure();
    assertStoreId("job", job.id);
    await writeJson(this.jobPath(job.id), job);
  }

  async getRouterBinding(triggerId: string, subjectKey: string): Promise<RouterBinding | null> {
    return readJsonOr<RouterBinding | null>(this.routerBindingPath(triggerId, subjectKey), null);
  }

  async saveRouterBinding(binding: RouterBinding): Promise<void> {
    await this.ensure();
    await writeJson(this.routerBindingPath(binding.triggerId, binding.subjectKey), binding, { sync: true });
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
    return this.resolveJobReference(id);
  }

  async updateJob(id: string, patch: Partial<Job>): Promise<Job> {
    const current = await this.getJob(id);
    if (!current) throw new Error(`No job found with id "${id}"`);
    return withFileLock(this.jobLockPath(current.id), async () => {
      const fresh = await this.getJob(current.id);
      if (!fresh) throw new Error(`No job found with id "${current.id}"`);
      if (fresh.status === "cancelled" && patch.status && patch.status !== "cancelled") return fresh;
      const updated = { ...fresh, ...patch };
      await this.saveJob(updated);
      return updated;
    });
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
    return withFileLock(this.jobLockPath(job.id), async () => {
      const fresh = await this.getJob(job.id);
      if (!fresh) throw new Error(`No job found with id "${job.id}"`);
      if (isTerminalJobStatus(fresh.status)) return fresh;
      const updated = {
        ...fresh,
        status: "cancelled" as const,
        completedAt: nowIso(),
        error: fresh.status === "running" ? "Cancellation requested after process start" : "Cancelled before start",
      };
      await this.saveJob(updated);
      await this.appendLedger({ event: "pollinate.job.cancelled", job_id: fresh.id, trigger_id: fresh.triggerId });
      return updated;
    });
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

  async garbageCollectJobs(options: JobRetentionOptions): Promise<JobRetentionResult> {
    if (!Number.isFinite(options.terminalOlderThanDays) || options.terminalOlderThanDays <= 0) {
      throw new Error("Job retention requires terminalOlderThanDays > 0");
    }
    const keepLastPerTrigger = Math.max(0, Math.floor(options.keepLastPerTrigger ?? 0));
    const now = options.now ?? new Date();
    const cutoffMs = now.getTime() - options.terminalOlderThanDays * 24 * 60 * 60_000;
    const cutoff = new Date(cutoffMs).toISOString();
    const jobs = await this.listJobs();
    const terminal = jobs.filter((job) => isTerminalJobStatus(job.status));
    const protectedIds = keepLastPerTrigger > 0 ? newestTerminalJobsByTrigger(terminal, keepLastPerTrigger) : new Set<string>();
    const deleteCandidates = terminal.filter((job) => {
      if (protectedIds.has(job.id)) return false;
      const finishedAt = job.completedAt ?? job.queuedAt;
      return new Date(finishedAt).getTime() < cutoffMs;
    });

    const deletedJobIds: string[] = [];
    const deletedUuids: string[] = [];
    for (const job of deleteCandidates) {
      await unlink(this.jobPath(job.id)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      deletedJobIds.push(job.id);
      if (job.uuid) deletedUuids.push(job.uuid);
    }
    const prunedJobUuids = await pruneJobIdIndex(this.root, deletedUuids);

    return {
      cutoff,
      deleted: deletedJobIds.length,
      kept: jobs.length - deletedJobIds.length,
      prunedJobUuids,
      deletedJobIds,
    };
  }

  async appendLedger(event: LedgerEvent): Promise<void> {
    await appendJsonLine(ledgerPath(this.root), { ts: nowIso(), ...event });
  }

  async readLedger(lines?: number): Promise<string[]> {
    const path = ledgerPath(this.root);
    if (lines !== undefined) return readLedgerTail(path, lines);

    const info = await stat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      this.ledgerCache = undefined;
      return [];
    }

    if (!this.ledgerCache || this.ledgerCache.path !== path || info.size < this.ledgerCache.size) {
      const text = await readTextOrNull(path);
      if (!text) {
        this.ledgerCache = { path, size: info.size, lines: [], partial: "" };
        return [];
      }
      const parsed = splitLedgerText(text);
      this.ledgerCache = { path, size: info.size, ...parsed };
      return ledgerLinesWithPartial(this.ledgerCache);
    }

    if (info.size === this.ledgerCache.size) return ledgerLinesWithPartial(this.ledgerCache);

    const appended = await readFileRange(path, this.ledgerCache.size, info.size - this.ledgerCache.size);
    const parsed = splitLedgerText(`${this.ledgerCache.partial}${appended}`);
    this.ledgerCache.lines.push(...parsed.lines);
    this.ledgerCache.partial = parsed.partial;
    this.ledgerCache.size = info.size;
    return ledgerLinesWithPartial(this.ledgerCache);
  }
}

function safePathPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  if (safe && safe === value) return safe;
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return `${safe || "binding"}-${hash}`;
}

function assertStoreId(kind: "trigger" | "job", id: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..") return id;
  throw new Error(`Invalid ${kind} id "${id}"; use only letters, numbers, ".", "_", and "-"`);
}

function prepareTriggerForSave(incoming: Trigger, current: Trigger | null): Trigger {
  const updatedAt = nowIso();
  if (!current) return { ...incoming, updatedAt };
  if (isDeliveryCounterSave(current, incoming)) return mergeDeliveryCounterSave(current, incoming, updatedAt);
  if (isEnabledOnlySave(current, incoming)) return { ...current, enabled: incoming.enabled, updatedAt };
  return { ...incoming, updatedAt };
}

function mergeDeliveryCounterSave(current: Trigger, incoming: Trigger, updatedAt: string): Trigger {
  const currentDeliveries = current.lifecycle?.deliveries ?? 0;
  const incomingDeliveries = incoming.lifecycle?.deliveries ?? 0;
  const maxDeliveries = current.lifecycle?.maxDeliveries ?? incoming.lifecycle?.maxDeliveries;
  if (incomingDeliveries > currentDeliveries) {
    const maxReached = maxDeliveries !== undefined && incomingDeliveries >= maxDeliveries;
    return {
      ...current,
      enabled: maxReached ? false : incoming.enabled,
      lifecycle: { ...current.lifecycle, ...incoming.lifecycle, deliveries: incomingDeliveries },
      updatedAt,
    };
  }
  if (maxDeliveries !== undefined && currentDeliveries >= maxDeliveries) {
    throw new Error(`Trigger "${incoming.id}" already reached maxDeliveries (${maxDeliveries})`);
  }

  const deliveries = currentDeliveries + 1;
  const maxReached = maxDeliveries !== undefined && deliveries >= maxDeliveries;
  return {
    ...current,
    enabled: maxReached ? false : incoming.enabled,
    lifecycle: { ...current.lifecycle, ...incoming.lifecycle, deliveries },
    updatedAt,
  };
}

function isDeliveryCounterSave(current: Trigger, incoming: Trigger): boolean {
  if (!current.lifecycle?.temporary || !incoming.lifecycle?.temporary) return false;
  if (incoming.lifecycle.deliveries === undefined) return false;
  if ((incoming.lifecycle.deliveries ?? 0) < 0) return false;
  return JSON.stringify(stripDeliveryCounterFields(current)) === JSON.stringify(stripDeliveryCounterFields(incoming));
}

function stripDeliveryCounterFields(trigger: Trigger): Trigger {
  const lifecycle = trigger.lifecycle ? { ...trigger.lifecycle, deliveries: undefined } : undefined;
  return { ...trigger, enabled: undefined as unknown as boolean, updatedAt: "", lifecycle };
}

function isEnabledOnlySave(current: Trigger, incoming: Trigger): boolean {
  return JSON.stringify({ ...current, enabled: undefined as unknown as boolean, updatedAt: "" }) === JSON.stringify({ ...incoming, enabled: undefined as unknown as boolean, updatedAt: "" });
}

function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "errored" || status === "timed-out" || status === "cancelled";
}

function newestTerminalJobsByTrigger(jobs: Job[], keepLastPerTrigger: number): Set<string> {
  const byTrigger = new Map<string, Job[]>();
  for (const job of jobs) {
    const group = byTrigger.get(job.triggerId) ?? [];
    group.push(job);
    byTrigger.set(job.triggerId, group);
  }
  const keep = new Set<string>();
  for (const group of byTrigger.values()) {
    group
      .sort((a, b) => (b.completedAt ?? b.queuedAt).localeCompare(a.completedAt ?? a.queuedAt))
      .slice(0, keepLastPerTrigger)
      .forEach((job) => keep.add(job.id));
  }
  return keep;
}

async function readLedgerTail(path: string, lines: number): Promise<string[]> {
  if (lines <= 0) return [];
  const info = await stat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info || info.size === 0) return [];

  const chunks: string[] = [];
  let end = info.size;
  const chunkSize = 64 * 1024;
  while (end > 0) {
    const start = Math.max(0, end - chunkSize);
    chunks.unshift(await readFileRange(path, start, end - start));
    const parsed = ledgerLinesFromText(chunks.join(""));
    if (start === 0 || parsed.length > lines) return parsed.slice(-lines);
    end = start;
  }
  return [];
}

async function readFileRange(path: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function splitLedgerText(text: string): { lines: string[]; partial: string } {
  if (!text) return { lines: [], partial: "" };
  const parts = text.split("\n");
  const partial = text.endsWith("\n") ? "" : (parts.pop() ?? "");
  const lines = (text.endsWith("\n") ? parts.slice(0, -1) : parts).filter(Boolean);
  return { lines, partial };
}

function ledgerLinesWithPartial(cache: LedgerCache): string[] {
  return cache.partial ? [...cache.lines, cache.partial] : [...cache.lines];
}

function ledgerLinesFromText(text: string): string[] {
  const parsed = splitLedgerText(text);
  return parsed.partial ? [...parsed.lines, parsed.partial] : parsed.lines;
}
