import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, utimes } from "node:fs/promises";
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

export function routerBindingsDir(root = storeRoot()): string {
  return join(stateDir(root), "router-bindings");
}

export function routerPluginsDir(root = storeRoot()): string {
  return join(root, "router-plugins");
}

export function ledgerPath(root = storeRoot()): string {
  return join(root, "ledger.jsonl");
}

export function daemonLogPath(root = storeRoot()): string {
  return join(root, "daemon.log");
}

export function daemonConfigPath(root = storeRoot()): string {
  return join(root, "pollinate.toml");
}

export async function ensureStore(root = storeRoot()): Promise<void> {
  await mkdir(triggerDir(root), { recursive: true, mode: 0o700 });
  await mkdir(stateDir(root), { recursive: true, mode: 0o700 });
  await mkdir(jobsDir(root), { recursive: true, mode: 0o700 });
  await mkdir(routerBindingsDir(root), { recursive: true, mode: 0o700 });
  await mkdir(routerPluginsDir(root), { recursive: true, mode: 0o700 });
}

export async function atomicWriteFile(path: string, data: string | Buffer, options: { mode?: number; sync?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const mode = options.mode ?? 0o600;
  const sync = options.sync ?? false;
  const tmp = join(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(tmp, "w", mode);
    try {
      await handle.writeFile(data);
      if (sync) await handle.datasync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
    await chmod(path, mode).catch(() => undefined);
  } finally {
    if (!renamed) await unlink(tmp).catch(() => undefined);
  }
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
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    await quarantineCorruptJson(path, error);
    return fallback;
  }
}

export async function writeJson(path: string, value: unknown, options: { sync?: boolean } = {}): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, sync: options.sync });
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendTextLine(path, JSON.stringify(value));
}

export async function appendTextLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(`${line}\n`, "utf8");
    await handle.datasync();
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

const LOCK_STALE_MS = 15 * 60_000;
const LOCK_HEARTBEAT_MS = 10_000;

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let acquired = false;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${token}\n${new Date().toISOString()}\n`, "utf8");
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock(path);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await handle?.close();
      if (handle && !acquired) await unlinkOwnedLock(path, token);
    }
  }

  const heartbeat = setInterval(() => {
    void refreshOwnedLock(path, token);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await unlinkOwnedLock(path, token);
  }
}

async function removeStaleLock(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return;
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(path).catch(() => undefined);
}

async function refreshOwnedLock(path: string, token: string): Promise<void> {
  const current = await readLockToken(path);
  if (current !== token) return;
  const now = new Date();
  await utimes(path, now, now).catch(() => undefined);
}

async function unlinkOwnedLock(path: string, token: string): Promise<void> {
  const current = await readLockToken(path);
  if (current === token) await unlink(path).catch(() => undefined);
}

async function readLockToken(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\r?\n/, 1)[0];
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function quarantineCorruptJson(path: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.corrupt-${suffix}`;
  try {
    await rename(path, target);
    console.warn(`[pollinate] Corrupt JSON at ${path}: ${message}; moved to ${target}`);
  } catch (renameError) {
    if (isEnoent(renameError)) return;
    const renameMessage = renameError instanceof Error ? renameError.message : String(renameError);
    console.warn(`[pollinate] Corrupt JSON at ${path}: ${message}; failed to quarantine: ${renameMessage}`);
  }
}
