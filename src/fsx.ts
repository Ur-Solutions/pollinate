import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export function storeRoot(): string {
  return process.env.POLLINATE_STORE_ROOT || join(homedir(), ".pollinate");
}

export function triggerDir(root = storeRoot()): string {
  return join(root, "triggers");
}

export function stateDir(root = storeRoot()): string {
  return join(root, "state");
}

export function jobsDir(root = storeRoot()): string {
  return join(root, "jobs");
}

export function ledgerPath(root = storeRoot()): string {
  return join(root, "ledger.jsonl");
}

export function daemonConfigPath(root = storeRoot()): string {
  return join(root, "pollinate.toml");
}

export async function ensureStore(root = storeRoot()): Promise<void> {
  await mkdir(triggerDir(root), { recursive: true, mode: 0o700 });
  await mkdir(stateDir(root), { recursive: true, mode: 0o700 });
  await mkdir(jobsDir(root), { recursive: true, mode: 0o700 });
}

export async function atomicWriteFile(path: string, data: string | Buffer, options: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const mode = options.mode ?? 0o600;
  const tmp = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
  await chmod(path, mode).catch(() => undefined);
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  const text = await readTextOrNull(path);
  if (text === null || text.trim() === "") return fallback;
  return JSON.parse(text) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600).catch(() => undefined);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

const LOCK_STALE_MS = 30_000;

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
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
