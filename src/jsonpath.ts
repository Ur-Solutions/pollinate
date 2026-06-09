import { JSONPath } from "jsonpath-plus";

export function selectJsonPath(path: string, json: unknown): unknown {
  return JSONPath({ path, json: json as null | boolean | number | string | object | unknown[], wrap: false });
}

export function selectJsonPathArray(path: string, json: unknown): unknown[] {
  const result = JSONPath({ path, json: json as null | boolean | number | string | object | unknown[], wrap: true });
  return Array.isArray(result) ? result : [];
}
