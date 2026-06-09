import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile, jobsDir, readJsonOr, stateDir } from "./fsx.js";
import type { Job, Trigger } from "./types.js";

export type JobIdentity = {
  id: string;
  idPrefix: string;
  uuid: string;
};

type JobIdIndex = {
  used: string[];
};

export type AllocateJobIdentityOptions = {
  root: string;
  trigger: Trigger;
  uuid?: () => string;
};

export const MIN_JOB_ID_CHARS = 3;

const LOCK_STALE_MS = 30_000;

export async function allocateJobIdentity(options: AllocateJobIdentityOptions): Promise<JobIdentity> {
  return withFileLock(jobIdIndexLockPath(options.root), async () => {
    const indexed = await readJobIdIndex(options.root);
    const used = await mergeCurrentJobUuids(options.root, indexed.used);
    const uuidFactory = options.uuid ?? randomUUID;
    const idPrefix = jobPrefixForTrigger(options.trigger);

    for (let attempt = 0; attempt < 100_000; attempt += 1) {
      const uuid = normalizeJobUuid(uuidFactory());
      const position = insertionIndex(used, uuid);
      if (used[position] === uuid) continue;

      const length = minimumUniqueNormalizedUuidPrefixLength(uuid, used, position);
      const nextUsed = [...used];
      nextUsed.splice(position, 0, uuid);
      await writeJobIdIndex(options.root, { used: nextUsed });
      return { id: `${idPrefix}${uuid.slice(0, length)}`, idPrefix, uuid };
    }

    throw new Error("Could not allocate a unique job id after 100000 UUID attempts");
  });
}

export function jobPrefixForTrigger(trigger: Pick<Trigger, "id" | "name" | "source">): string {
  const seed = trigger.id || trigger.name || trigger.source.kind || "job";
  const cleaned = seed.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return `${(cleaned || "JO").slice(0, 2).padEnd(2, "X")}.`;
}

export function minimumUniqueUuidPrefixLength(uuidValue: string, sortedUsedValues: readonly string[], knownInsertionIndex?: number): number {
  const uuid = normalizeJobUuid(uuidValue);
  const sortedUsed = sortedUsedValues.map(normalizeJobUuid);
  const position = knownInsertionIndex ?? insertionIndex(sortedUsed, uuid);
  return minimumUniqueNormalizedUuidPrefixLength(uuid, sortedUsed, position);
}

function minimumUniqueNormalizedUuidPrefixLength(uuid: string, sortedUsed: readonly string[], position: number): number {
  // In a sorted set, the nearest lexicographic neighbors have the longest possible
  // common prefix with a new UUID, so they are sufficient to find the shortest
  // globally unused prefix.
  const previous = position > 0 ? sortedUsed[position - 1] : undefined;
  const next = sortedUsed[position];
  const shared = Math.max(previous ? commonPrefixLength(uuid, previous) : 0, next ? commonPrefixLength(uuid, next) : 0);
  return Math.min(uuid.length, Math.max(MIN_JOB_ID_CHARS, shared + 1));
}

export function matchesJobReference(job: Pick<Job, "id" | "uuid">, reference: string): boolean {
  const query = reference.trim();
  if (!query) return false;
  if (job.id === query) return true;

  const full = fullJobReference(job);
  if (full?.startsWith(query) && query.length >= job.id.length) return true;

  const suffix = suffixReference(job);
  if (suffix?.full.startsWith(query) && query.length >= suffix.display.length) return true;

  return !job.uuid && query.length >= MIN_JOB_ID_CHARS && job.id.startsWith(query);
}

export function fullJobReference(job: Pick<Job, "id" | "uuid">): string | undefined {
  if (!job.uuid) return job.id;
  const uuid = maybeNormalizeJobUuid(job.uuid);
  if (!uuid) return job.id;
  const dot = job.id.indexOf(".");
  const prefix = dot >= 0 ? job.id.slice(0, dot + 1) : "";
  return `${prefix}${uuid}`;
}

export function normalizeJobUuid(value: string): string {
  const normalized = value.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new Error(`Invalid UUID: ${value}`);
  return normalized;
}

function maybeNormalizeJobUuid(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return normalizeJobUuid(value);
  } catch {
    return undefined;
  }
}

function suffixReference(job: Pick<Job, "id" | "uuid">): { display: string; full: string } | undefined {
  const dot = job.id.indexOf(".");
  const display = dot >= 0 ? job.id.slice(dot + 1) : job.id;
  if (!display) return undefined;
  const uuid = maybeNormalizeJobUuid(job.uuid);
  return { display, full: uuid ?? display };
}

async function mergeCurrentJobUuids(root: string, indexed: string[]): Promise<string[]> {
  const used = new Set(indexed.map(normalizeJobUuid));
  for (const uuid of await currentJobUuids(root)) used.add(uuid);
  return [...used].sort();
}

async function currentJobUuids(root: string): Promise<string[]> {
  const entries = await readdir(jobsDir(root)).catch(() => []);
  const uuids: string[] = [];
  for (const entry of entries.filter((item) => item.endsWith(".json"))) {
    const id = entry.slice(0, -".json".length);
    const idUuid = maybeNormalizeJobUuid(id);
    if (idUuid) uuids.push(idUuid);

    const job = await readJsonOr<Partial<Job> | null>(join(jobsDir(root), entry), null);
    const jobUuid = maybeNormalizeJobUuid(job?.uuid);
    if (jobUuid) uuids.push(jobUuid);
  }
  return uuids;
}

async function readJobIdIndex(root: string): Promise<JobIdIndex> {
  try {
    const parsed = JSON.parse(await readFile(jobIdIndexPath(root), "utf8")) as unknown;
    const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { used: Array.isArray(object.used) ? object.used.map((value) => normalizeJobUuid(String(value))).sort() : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { used: [] };
    throw error;
  }
}

async function writeJobIdIndex(root: string, index: JobIdIndex): Promise<void> {
  await atomicWriteFile(jobIdIndexPath(root), `${JSON.stringify({ used: [...new Set(index.used.map(normalizeJobUuid))].sort() }, null, 2)}\n`, { mode: 0o600 });
}

function jobIdIndexPath(root: string): string {
  return join(stateDir(root), "job-id-index.json");
}

function jobIdIndexLockPath(root: string): string {
  return join(stateDir(root), "job-id-index.lock");
}

function insertionIndex(sorted: readonly string[], value: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a[length] === b[length]) length += 1;
  return length;
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock(path);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await handle?.close();
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

async function removeStaleLock(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return;
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(path).catch(() => undefined);
}
