import type { Filter, JsonValue } from "./types.js";
import { stableStringify } from "./time.js";

export function matchesFilter(filter: Filter | undefined, payload: JsonValue): boolean {
  if (!filter) return true;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const object = payload as Record<string, JsonValue>;
  return Object.entries(filter).every(([key, expected]) => {
    if (expected === true) return Object.prototype.hasOwnProperty.call(object, key);
    return stableStringify(object[key]) === stableStringify(expected);
  });
}
