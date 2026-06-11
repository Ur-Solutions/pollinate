import { describe, expect, test } from "vitest";
import { renderAction, renderJsonValue, renderString, stringifyTemplateValue } from "../src/templates.js";
import type { Action } from "../src/types.js";

describe("renderString", () => {
  test("substitutes known vars and stringifies non-strings", () => {
    const rendered = renderString("PR {{pr_number}} by {{author}} ({{merged}})", {
      pr_number: 7,
      author: "alice",
      merged: false,
    });
    expect(rendered.value).toBe("PR 7 by alice (false)");
    expect(rendered.warnings).toEqual([]);
  });

  test("keeps unresolved placeholders literal and warns once per occurrence", () => {
    const rendered = renderString("{{known}} and {{unknown}}", { known: "yes" });
    expect(rendered.value).toBe("yes and {{unknown}}");
    expect(rendered.warnings).toEqual(["Unresolved template var: unknown"]);
  });

  test("supports dotted variable names like binding.target", () => {
    const rendered = renderString("kill {{binding.target}}", { "binding.target": "pr-9" });
    expect(rendered.value).toBe("kill pr-9");
  });

  test("renders undefined values as empty strings", () => {
    expect(renderString("[{{maybe}}]", { maybe: undefined }).value).toBe("[]");
  });
});

describe("stringifyTemplateValue", () => {
  test("passes strings through and JSON-encodes objects", () => {
    expect(stringifyTemplateValue("plain")).toBe("plain");
    expect(stringifyTemplateValue({ a: 1 })).toBe('{"a":1}');
    expect(stringifyTemplateValue(undefined)).toBe("");
    expect(stringifyTemplateValue(null)).toBe("null");
  });
});

describe("renderJsonValue", () => {
  test("renders nested arrays and object keys, aggregating warnings", () => {
    const rendered = renderJsonValue(
      { "{{key}}": ["{{a}}", { inner: "{{missing}}" }] },
      { key: "renamed", a: "first" },
    );
    expect(rendered.value).toEqual({ renamed: ["first", { inner: "{{missing}}" }] });
    expect(rendered.warnings).toEqual(["Unresolved template var: missing"]);
  });

  test("returns non-string primitives untouched", () => {
    expect(renderJsonValue(42, {}).value).toBe(42);
    expect(renderJsonValue(null, {}).value).toBeNull();
  });
});

describe("renderAction", () => {
  test("renders every string field of a honeybee action", () => {
    const action: Action = {
      kind: "honeybee",
      run: "spawn",
      bee: "codex",
      name: "pr-{{pr_number}}",
      message: "Review {{repo}}#{{pr_number}}",
      args: ["--allowedTools", "{{tools}}"],
    };
    const rendered = renderAction(action, { pr_number: "12", repo: "trmd/demo", tools: "Read" });
    expect(rendered.value).toMatchObject({
      name: "pr-12",
      message: "Review trmd/demo#12",
      args: ["--allowedTools", "Read"],
    });
    expect(rendered.warnings).toEqual([]);
  });

  test("renders nested sequence actions", () => {
    const action: Action = {
      kind: "sequence",
      actions: [
        { id: "a", action: { kind: "honeybee", run: "send", target: "{{binding.targets.a}}", message: "{{activity_markdown}}" } },
      ],
    };
    const rendered = renderAction(action, { "binding.targets.a": "bee-a", activity_markdown: "hello" });
    expect(rendered.value).toMatchObject({
      actions: [{ id: "a", action: { target: "bee-a", message: "hello" } }],
    });
  });
});
