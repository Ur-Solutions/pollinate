import type { Action, JsonValue } from "./types.js";
import { shellQuote } from "./process.js";

const TEMPLATE_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export type Rendered<T> = {
  value: T;
  warnings: string[];
};

export function stringifyTemplateValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

export function renderString(input: string, vars: Record<string, unknown>): Rendered<string> {
  const warnings: string[] = [];
  const value = input.replace(TEMPLATE_RE, (literal, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      warnings.push(`Unresolved template var: ${key}`);
      return literal;
    }
    return stringifyTemplateValue(vars[key]);
  });
  return { value, warnings };
}

export function renderShellCommand(input: string, vars: Record<string, unknown>): Rendered<string> {
  const warnings: string[] = [];
  const value = input.replace(TEMPLATE_RE, (literal, key: string, offset: number) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      warnings.push(`Unresolved template var: ${key}`);
      return literal;
    }
    return shellEscapeTemplateValue(stringifyTemplateValue(vars[key]), shellQuoteContextAt(input, offset));
  });
  return { value, warnings };
}

export function renderJsonValue<T extends JsonValue | string | undefined>(
  input: T,
  vars: Record<string, unknown>,
): Rendered<T> {
  if (typeof input === "string") return renderString(input, vars) as Rendered<T>;
  if (input === undefined || input === null || typeof input !== "object") return { value: input, warnings: [] };
  if (Array.isArray(input)) {
    const warnings: string[] = [];
    const value = input.map((item) => {
      const rendered = renderJsonValue(item, vars);
      warnings.push(...rendered.warnings);
      return rendered.value;
    }) as T;
    return { value, warnings };
  }
  const warnings: string[] = [];
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const renderedKey = renderString(key, vars);
    const renderedValue = renderJsonValue(value, vars);
    warnings.push(...renderedKey.warnings, ...renderedValue.warnings);
    output[renderedKey.value] = renderedValue.value as JsonValue;
  }
  return { value: output as T, warnings };
}

export function renderAction(action: Action, vars: Record<string, unknown>): Rendered<Action> {
  const rendered = renderActionJsonValue(action as unknown as JsonValue, vars);
  return { value: rendered.value as unknown as Action, warnings: rendered.warnings };
}

function renderActionJsonValue<T extends JsonValue | string | undefined>(
  input: T,
  vars: Record<string, unknown>,
  fieldKey?: string,
  inCommandAction = false,
): Rendered<T> {
  if (typeof input === "string") {
    return (inCommandAction && fieldKey === "command" ? renderShellCommand(input, vars) : renderString(input, vars)) as Rendered<T>;
  }
  if (input === undefined || input === null || typeof input !== "object") return { value: input, warnings: [] };
  if (Array.isArray(input)) {
    const warnings: string[] = [];
    const value = input.map((item) => {
      const rendered = renderActionJsonValue(item, vars);
      warnings.push(...rendered.warnings);
      return rendered.value;
    }) as T;
    return { value, warnings };
  }
  const warnings: string[] = [];
  const output: Record<string, JsonValue> = {};
  const commandAction = (input as Record<string, JsonValue>).kind === "command";
  for (const [key, value] of Object.entries(input)) {
    const renderedKey = renderString(key, vars);
    const renderedValue = renderActionJsonValue(value, vars, key, commandAction);
    warnings.push(...renderedKey.warnings, ...renderedValue.warnings);
    output[renderedKey.value] = renderedValue.value as JsonValue;
  }
  return { value: output as T, warnings };
}

function shellEscapeTemplateValue(value: string, context: "single" | "double" | "unquoted"): string {
  if (context === "single") return `'${shellQuote(value)}'`;
  if (context === "double") return value.replace(/["\\$`]/g, (char) => `\\${char}`);
  return shellQuote(value);
}

function shellQuoteContextAt(input: string, offset: number): "single" | "double" | "unquoted" {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < offset; index += 1) {
    const char = input[index];
    if (char === "\\" && quote !== "single") {
      index += 1;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === "\"") quote = undefined;
      continue;
    }
    if (char === "'") quote = "single";
    else if (char === "\"") quote = "double";
  }
  return quote ?? "unquoted";
}
