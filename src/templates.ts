import type { Action, CombRunAction, JsonValue } from "./types.js";
import { shellQuote } from "./process.js";

const TEMPLATE_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const WHOLE_TEMPLATE_RE = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

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
    if (!Object.hasOwn(vars, key)) {
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
    if (!Object.hasOwn(vars, key)) {
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

/**
 * Render a Comb input without weakening JSON types. Exact placeholders are
 * JSON-decoded; mixed strings remain strings. Unlike ordinary templates, every
 * unresolved Comb input placeholder is fatal.
 */
export function renderCombInput(value: JsonValue, vars: Record<string, unknown>): JsonValue {
  if (Array.isArray(value)) return value.map((item) => renderCombInput(item, vars));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderCombInput(item, vars)]),
    );
  }
  if (typeof value !== "string") return value;

  const whole = WHOLE_TEMPLATE_RE.exec(value);
  if (whole) {
    const key = whole[1] ?? "";
    if (!Object.hasOwn(vars, key)) {
      throw new Error(`Unresolved Comb input template var: ${key}`);
    }
    const rendered = stringifyTemplateValue(vars[key]);
    try {
      return JSON.parse(rendered) as JsonValue;
    } catch {
      return rendered;
    }
  }

  const rendered = renderString(value, vars);
  if (rendered.warnings.length > 0) {
    const missing = [...value.matchAll(TEMPLATE_RE)]
      .flatMap((match) => match[1] ? [match[1]] : [])
      .filter((key) => !Object.hasOwn(vars, key));
    throw new Error(`Unresolved Comb input template var: ${[...new Set(missing)].join(", ")}`);
  }
  return rendered.value;
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
  if (isCombRunAction(input)) {
    const action = input as unknown as CombRunAction;
    return {
      value: {
        ...action,
        input: renderCombInput(action.input, vars),
      } as unknown as T,
      warnings: [],
    };
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

function isCombRunAction(value: object): boolean {
  const record = value as Record<string, unknown>;
  return record.kind === "honeybee" && record.run === "comb";
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
