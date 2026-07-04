const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseDuration(value: string | undefined, fallbackMs?: number): number {
  if (!value) {
    if (fallbackMs === undefined) throw new Error("duration is required");
    return fallbackMs;
  }
  const match = DURATION_RE.exec(value.trim());
  if (!match) throw new Error(`Invalid duration "${value}". Use forms like 500ms, 30s, 5m, 2h, 1d.`);
  const amount = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    case "d":
      return amount * 86_400_000;
    default:
      throw new Error(`Unsupported duration unit "${unit}"`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isoAfter(ms: number, from = new Date()): string {
  return new Date(from.getTime() + ms).toISOString();
}

export function parseIsoDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${label}: ${value}`);
  return date;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
