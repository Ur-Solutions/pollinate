import type { Action, JsonValue } from "./types.js";

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
  const rendered = renderJsonValue(action as unknown as JsonValue, vars);
  return { value: rendered.value as unknown as Action, warnings: rendered.warnings };
}
