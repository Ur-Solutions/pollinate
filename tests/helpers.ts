import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { PollinateStore, type Job, type JobStatus, type Trigger } from "../src/index.js";

export async function withTempStore<T>(fn: (store: PollinateStore, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pollinate-test-"));
  const previous = process.env.POLLINATE_STORE_ROOT;
  process.env.POLLINATE_STORE_ROOT = root;
  try {
    const store = new PollinateStore(root);
    await store.ensure();
    return await fn(store, root);
  } finally {
    if (previous === undefined) delete process.env.POLLINATE_STORE_ROOT;
    else process.env.POLLINATE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

export function trigger(overrides: Partial<Trigger> = {}): Trigger {
  const now = new Date().toISOString();
  return {
    id: "test",
    name: "test",
    tags: [],
    enabled: true,
    source: { kind: "manual" },
    delivery: { mode: { strategy: "immediate" }, maxConcurrent: 1 },
    action: { kind: "emit", subject: "test", payload: "{{event}}" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export async function waitForJobs(store: PollinateStore, count: number, status?: JobStatus, timeoutMs = 2_000): Promise<Job[]> {
  const start = Date.now();
  for (;;) {
    const jobs = await store.listJobs(status ? { status } : {});
    if (jobs.length >= count) return jobs;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${count} jobs${status ? ` with ${status}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function waitForTerminalJobs(store: PollinateStore, count: number, timeoutMs = 3_000): Promise<Job[]> {
  const start = Date.now();
  const terminal = new Set<JobStatus>(["completed", "errored", "timed-out", "cancelled"]);
  for (;;) {
    const jobs = await store.listJobs();
    const done = jobs.filter((job) => terminal.has(job.status));
    if (done.length >= count) return done;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${count} terminal jobs`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function useFakeTimers(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true });
}
