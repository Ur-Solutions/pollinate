import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { PollinateStore, type Job, type JobStatus, type Trigger } from "../src/index.js";

const pathStubRefs = new Map<string, number>();

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
    await removeWithRetry(root);
  }
}

// In-flight async writes (poll ticks, ledger appends) can land while rm walks
// the tree, surfacing as ENOTEMPTY; retry briefly instead of failing the test.
async function removeWithRetry(root: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
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

export type CommandStub = {
  binDir: string;
  logPath: string;
  log(): Promise<string>;
  restore(): void;
};

/**
 * Installs a PATH-hijacking `hive` stub under <root>/bin. It logs every
 * invocation to <root>/hive.log and answers `spawn` with a hive-style TSV row
 * whose handle echoes --name (or "spawned" when no name was passed).
 */
export async function installHiveStub(root: string, options: { script?: string } = {}): Promise<CommandStub> {
  const logPath = join(root, "hive.log");
  return installCommandStub(root, "hive", options.script ?? defaultHiveScript(logPath), logPath);
}

/** Installs an arbitrary PATH-hijacking command stub next to the hive stub. */
export async function installCommandStub(root: string, name: string, script: string, logPath = join(root, `${name}.log`)): Promise<CommandStub> {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, name), name === "hermes" ? script : stripNoopStdinDrain(script));
  await chmod(join(binDir, name), 0o700);
  const refs = pathStubRefs.get(binDir) ?? 0;
  if (refs === 0 && !pathParts(process.env.PATH).includes(binDir)) process.env.PATH = [binDir, ...pathParts(process.env.PATH)].join(delimiter);
  pathStubRefs.set(binDir, refs + 1);
  let restored = false;
  return {
    binDir,
    logPath,
    log: () => readFile(logPath, "utf8").catch(() => ""),
    restore() {
      if (restored) return;
      restored = true;
      const nextRefs = (pathStubRefs.get(binDir) ?? 1) - 1;
      if (nextRefs > 0) {
        pathStubRefs.set(binDir, nextRefs);
        return;
      }
      pathStubRefs.delete(binDir);
      const nextPath = pathParts(process.env.PATH)
        .filter((part) => part !== binDir)
        .join(delimiter);
      if (nextPath) process.env.PATH = nextPath;
      else delete process.env.PATH;
    },
  };
}

function pathParts(value: string | undefined): string[] {
  return value ? value.split(delimiter).filter(Boolean) : [];
}

function stripNoopStdinDrain(script: string): string {
  return script.replace(/(^|\n)cat >\/dev\/null\n/g, "$1");
}

function defaultHiveScript(logPath: string): string {
  return `#!/bin/sh
echo "$@" >> "${logPath}"
if [ "$1" = "spawn" ]; then
  name="spawned"
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--name" ]; then name="$arg"; fi
    prev="$arg"
  done
  printf '%s\\tcodex\\t/tmp\\tlocal\\n' "$name"
fi
`;
}
