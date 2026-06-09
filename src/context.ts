import { readFile } from "node:fs/promises";
import { execShell } from "./process.js";
import { selectJsonPath } from "./jsonpath.js";
import { renderString } from "./templates.js";
import { parseDuration, withTimeout } from "./time.js";
import type { Activation, ContextResolver, ExecutionProfile, Trigger } from "./types.js";

export type ResolvedContext = {
  context: Record<string, string>;
  warnings: string[];
};

export async function resolveContext(
  trigger: Trigger,
  activation: Activation,
  options: { defaultTimeoutMs: number; cwd?: string; execution?: ExecutionProfile },
): Promise<ResolvedContext> {
  const context: Record<string, string> = {
    trigger_id: trigger.id,
    fired_at: new Date().toISOString(),
    source_kind: activation.source,
    event: JSON.stringify(activation.payload),
  };
  const warnings: string[] = [];
  const resolver = trigger.context;
  if (!resolver) return { context, warnings };
  Object.assign(context, resolver.static ?? {});
  const defaultCwd = renderCwd(options.cwd, context);
  warnings.push(...defaultCwd.warnings);
  const sourceResults = await Promise.all(
    (resolver.sources ?? []).map((source) => resolveSource(resolver, source, options.defaultTimeoutMs, defaultCwd.value, context, options.execution)),
  );
  for (const result of sourceResults) {
    warnings.push(...result.warnings);
    if (result.ok) context[result.variable] = result.value;
    else warnings.push(result.warning);
  }
  return { context, warnings };
}

async function resolveSource(
  _resolver: ContextResolver,
  source: NonNullable<ContextResolver["sources"]>[number],
  defaultTimeoutMs: number,
  defaultCwd: string | undefined,
  context: Record<string, string>,
  execution: ExecutionProfile | undefined,
): Promise<{ ok: true; variable: string; value: string; warnings: string[] } | { ok: false; warning: string; warnings: string[] }> {
  const timeoutMs = parseDuration(source.timeout, defaultTimeoutMs);
  const cwd =
    source.kind === "command"
      ? renderCwd(source.cwd ?? defaultCwd, context)
      : source.kind === "honeybee"
        ? renderCwd(defaultCwd, context)
        : { value: undefined, warnings: [] };
  try {
    const value = await withTimeout(resolveSourceValue(source, cwd.value, execution), timeoutMs, `context source ${source.var}`);
    return { ok: true, variable: source.var, value, warnings: cwd.warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, warning: `Context source "${source.var}" failed: ${message}`, warnings: cwd.warnings };
  }
}

async function resolveSourceValue(source: NonNullable<ContextResolver["sources"]>[number], cwd?: string, execution?: ExecutionProfile): Promise<string> {
  if (source.kind === "command") {
    const result = await execShell(source.command, { cwd, execution });
    if (result.exitCode !== 0) throw new Error(`command exited ${result.exitCode}: ${result.stderr.trim()}`);
    return result.stdout.trimEnd();
  }
  if (source.kind === "http") {
    const response = await fetch(source.url);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    if (!source.jsonpath) return text;
    const json = JSON.parse(text);
    const selected = selectJsonPath(source.jsonpath, json);
    return typeof selected === "string" ? selected : JSON.stringify(selected);
  }
  if (source.kind === "file") {
    return (await readFile(source.path, "utf8")).trimEnd();
  }
  if (source.kind === "honeybee") {
    const result = await execShell(`hive ${source.query}`, { cwd, execution });
    if (result.exitCode !== 0) throw new Error(`hive exited ${result.exitCode}: ${result.stderr.trim()}`);
    return result.stdout.trimEnd();
  }
  const neverSource: never = source;
  throw new Error(`Unsupported context source: ${JSON.stringify(neverSource)}`);
}

function renderCwd(cwd: string | undefined, vars: Record<string, string>): { value: string | undefined; warnings: string[] } {
  if (!cwd) return { value: undefined, warnings: [] };
  return renderString(cwd, vars);
}
