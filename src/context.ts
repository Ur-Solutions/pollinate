import { readFile } from "node:fs/promises";
import { execArgv, execShell } from "./process.js";
import { selectJsonPath } from "./jsonpath.js";
import { renderShellCommand, renderString, type Rendered } from "./templates.js";
import { parseDuration, withTimeout } from "./time.js";
import type { Activation, ContextResolver, ExecutionProfile, Trigger } from "./types.js";

export type ResolvedContext = {
  context: Record<string, string>;
  warnings: string[];
};

type RenderedContextSource =
  | { var: string; kind: "command"; command: string; timeout?: string }
  | { var: string; kind: "http"; url: string; jsonpath?: string; timeout?: string }
  | { var: string; kind: "file"; path: string; timeout?: string }
  | { var: string; kind: "honeybee"; args: string[]; timeout?: string };

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
  const warnings = [...cwd.warnings];
  try {
    const renderedSource = renderSource(source, context);
    warnings.push(...renderedSource.warnings);
    const sourceValue = startSourceValue(renderedSource.value, cwd.value, execution, timeoutMs);
    const value = await withTimeout(sourceValue.promise, timeoutMs, `context source ${source.var}`, sourceValue.cancel);
    return { ok: true, variable: source.var, value, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, warning: `Context source "${source.var}" failed: ${message}`, warnings };
  }
}

function startSourceValue(
  source: RenderedContextSource,
  cwd: string | undefined,
  execution: ExecutionProfile | undefined,
  timeoutMs: number,
): { promise: Promise<string>; cancel?: () => void } {
  if (source.kind === "command") {
    return {
      promise: execShell(source.command, { cwd, execution, timeoutMs }).then((result) => {
        if (result.timedOut) throw new Error(`command timed out after ${timeoutMs}ms`);
        if (result.exitCode !== 0) throw new Error(`command exited ${result.exitCode}: ${result.stderr.trim()}`);
        return result.stdout.trimEnd();
      }),
    };
  }
  if (source.kind === "http") {
    const controller = new AbortController();
    return {
      cancel: () => controller.abort(),
      promise: fetch(source.url, { signal: controller.signal }).then(async (response) => {
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        if (!source.jsonpath) return text;
        const json = JSON.parse(text);
        const selected = selectJsonPath(source.jsonpath, json);
        return typeof selected === "string" ? selected : JSON.stringify(selected);
      }),
    };
  }
  if (source.kind === "file") {
    return { promise: readFile(source.path, "utf8").then((value) => value.trimEnd()) };
  }
  if (source.kind === "honeybee") {
    return {
      promise: execArgv("hive", source.args, { cwd, execution, timeoutMs }).then((result) => {
        if (result.timedOut) throw new Error(`hive timed out after ${timeoutMs}ms`);
        if (result.exitCode !== 0) throw new Error(`hive exited ${result.exitCode}: ${result.stderr.trim()}`);
        return result.stdout.trimEnd();
      }),
    };
  }
  const neverSource: never = source;
  throw new Error(`Unsupported context source: ${JSON.stringify(neverSource)}`);
}

function renderSource(source: NonNullable<ContextResolver["sources"]>[number], vars: Record<string, string>): Rendered<RenderedContextSource> {
  if (source.kind === "command") {
    const command = renderShellCommand(source.command, vars);
    return { value: { ...source, command: command.value }, warnings: command.warnings };
  }
  if (source.kind === "http") {
    const url = renderString(source.url, vars);
    const jsonpath = source.jsonpath ? renderString(source.jsonpath, vars) : { value: undefined, warnings: [] };
    return {
      value: { ...source, url: url.value, jsonpath: jsonpath.value },
      warnings: [...url.warnings, ...jsonpath.warnings],
    };
  }
  if (source.kind === "file") {
    const path = renderString(source.path, vars);
    return { value: { ...source, path: path.value }, warnings: path.warnings };
  }
  if (source.kind === "honeybee") {
    return renderHoneybeeSource(source, vars);
  }
  const neverSource: never = source;
  throw new Error(`Unsupported context source: ${JSON.stringify(neverSource)}`);
}

function renderHoneybeeSource(
  source: Extract<NonNullable<ContextResolver["sources"]>[number], { kind: "honeybee" }>,
  vars: Record<string, string>,
): Rendered<RenderedContextSource> {
  const warnings: string[] = [];
  const args = tokenizeArgv(source.query).map((arg) => {
    const rendered = renderString(arg, vars);
    warnings.push(...rendered.warnings);
    return rendered.value;
  });
  return { value: { var: source.var, kind: "honeybee", args, timeout: source.timeout }, warnings };
}

function renderCwd(cwd: string | undefined, vars: Record<string, string>): { value: string | undefined; warnings: string[] } {
  if (!cwd) return { value: undefined, warnings: [] };
  return renderString(cwd, vars);
}

function tokenizeArgv(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let tokenStarted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote === "single") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (quote === "double") {
      if (char === "\"") {
        quote = undefined;
      } else if (char === "\\" && index + 1 < input.length && "\"\\$`\n".includes(input[index + 1]!)) {
        current += input[index + 1]!;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    tokenStarted = true;
    if (char === "'") quote = "single";
    else if (char === "\"") quote = "double";
    else if (char === "\\" && index + 1 < input.length) {
      current += input[index + 1]!;
      index += 1;
    } else {
      current += char;
    }
  }
  if (quote) throw new Error(`Unterminated ${quote} quote in honeybee context query`);
  if (tokenStarted) args.push(current);
  return args;
}
