import { describe, expect, test } from "vitest";
import {
  clampSidebarWidth,
  isSidebarTab,
  sidebarCommand,
  SIDEBAR_TABS,
  __testOnlySplitArgs,
} from "../src/sidebar.js";
import {
  filterRows,
  formToScheduleTiming,
  jobHiveHandle,
  nextTab,
  renderRow,
  renderRowLines,
  renderTabBar,
  rowsForTab,
  scheduleTimingToForm,
  scheduleNextRunLabel,
  sidebarSignature,
  type SidebarData,
} from "../src/sidebarTui.js";
import { fireTriggerNow } from "../src/actions.js";
import { detectColorLevel, strip } from "../src/ui.js";
import type { Job, RouterBinding } from "../src/index.js";
import { trigger, withTempStore } from "./helpers.js";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "JO.aaa",
    triggerId: "t1",
    source: "manual",
    status: "completed",
    context: {},
    queuedAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function binding(overrides: Partial<RouterBinding> = {}): RouterBinding {
  return {
    id: "t1.pr-1",
    triggerId: "t1",
    router: "github-pr",
    subjectKey: "pr-1",
    status: "active",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    ...overrides,
  };
}

function data(overrides: Partial<SidebarData> = {}): SidebarData {
  return { triggers: [], active: [], history: [], bindings: [], ...overrides };
}

describe("tab model", () => {
  test("nextTab cycles forward and wraps", () => {
    expect(nextTab("triggers", 1)).toBe("active");
    expect(nextTab("active", 1)).toBe("history");
    expect(nextTab("history", 1)).toBe("triggers");
  });

  test("nextTab cycles backward and wraps", () => {
    expect(nextTab("triggers", -1)).toBe("history");
    expect(nextTab("history", -1)).toBe("active");
  });

  test("isSidebarTab guards bad input", () => {
    expect(SIDEBAR_TABS).toEqual(["triggers", "active", "history"]);
    expect(isSidebarTab("active")).toBe(true);
    expect(isSidebarTab("nope")).toBe(false);
    expect(isSidebarTab(undefined)).toBe(false);
  });
});

describe("rowsForTab", () => {
  const t = trigger({ id: "t1" });
  const running = job({ id: "JO.run", status: "running" });
  const queued = job({ id: "JO.q", status: "queued" });
  const doneJob = job({ id: "JO.done", status: "completed" });
  const activeBinding = binding({ id: "t1.pr-1", status: "active", target: { kind: "hive", handle: "pr-1" } });
  const closedBinding = binding({ id: "t1.pr-2", status: "closed" });
  const seed = data({
    triggers: [t],
    active: [running, queued],
    history: [doneJob],
    bindings: [activeBinding, closedBinding],
  });

  test("triggers tab lists triggers", () => {
    const rows = rowsForTab("triggers", seed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "trigger", id: "t1" });
  });

  test("active tab merges non-terminal jobs and live bindings only", () => {
    const rows = rowsForTab("active", seed);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["JO.run", "JO.q", "t1.pr-1"]); // closed binding excluded
    const bindingRow = rows.find((r) => r.kind === "binding");
    expect(bindingRow && "hiveHandle" in bindingRow ? bindingRow.hiveHandle : undefined).toBe("pr-1");
  });

  test("history tab lists terminal jobs", () => {
    const rows = rowsForTab("history", seed);
    expect(rows.map((r) => r.id)).toEqual(["JO.done"]);
  });
});

describe("jobHiveHandle", () => {
  test("reads result.handle", () => {
    expect(jobHiveHandle(job({ result: { handle: "bee-1" } }))).toBe("bee-1");
  });
  test("falls back to first result.handles value", () => {
    expect(jobHiveHandle(job({ result: { handles: { a: "bee-a", b: "bee-b" } } }))).toBe("bee-a");
  });
  test("undefined when no handle", () => {
    expect(jobHiveHandle(job({ result: { ok: true } }))).toBeUndefined();
    expect(jobHiveHandle(job({ result: undefined }))).toBeUndefined();
  });
});

describe("sidebarSignature", () => {
  test("is stable across identical data and changes on status flip", () => {
    const a = data({ active: [job({ id: "JO.1", status: "running" })] });
    const b = data({ active: [job({ id: "JO.1", status: "running" })] });
    expect(sidebarSignature(a)).toBe(sidebarSignature(b));
    const c = data({ active: [job({ id: "JO.1", status: "completed" })] });
    expect(sidebarSignature(a)).not.toBe(sidebarSignature(c));
  });

  test("changes when a binding target appears", () => {
    const before = data({ bindings: [binding({ target: undefined })] });
    const after = data({ bindings: [binding({ target: { kind: "hive", handle: "pr-1" } })] });
    expect(sidebarSignature(before)).not.toBe(sidebarSignature(after));
  });
});

describe("filterRows", () => {
  test("matches all space-separated terms against searchText", () => {
    const rows = rowsForTab("triggers", data({ triggers: [trigger({ id: "deploy-web" }), trigger({ id: "nightly-backup" })] }));
    expect(filterRows(rows, "deploy").map((r) => r.id)).toEqual(["deploy-web"]);
    expect(filterRows(rows, "  ").map((r) => r.id)).toEqual(["deploy-web", "nightly-backup"]);
  });
});

describe("sidebar rendering", () => {
  test("tmux sidebars ignore inherited automation no-color env", () => {
    const tty = { isTTY: true };
    expect(detectColorLevel({ NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" } as NodeJS.ProcessEnv, tty)).toBe(0);
    expect(detectColorLevel({ NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", TMUX: "/tmp/tmux/default,1,0" } as NodeJS.ProcessEnv, tty)).toBe(2);
    expect(detectColorLevel({ POLLINATE_NO_COLOR: "1", TERM: "tmux-256color", TMUX: "/tmp/tmux/default,1,0" } as NodeJS.ProcessEnv, tty)).toBe(0);
    expect(detectColorLevel({ POLLINATE_FORCE_COLOR: "0", TERM: "tmux-256color", TMUX: "/tmp/tmux/default,1,0" } as NodeJS.ProcessEnv, tty)).toBe(0);
  });

  test("active tab uses a visible text marker instead of inverse-video fill", () => {
    expect(strip(renderTabBar("active", 80))).toContain("[active]");
  });

  test("schedule rows show the time until the next run inline", () => {
    const now = new Date("2026-06-23T10:00:00.000Z");
    const sched = trigger({
      id: "nightly",
      source: { kind: "schedule", timing: { type: "every", interval: "5m" } },
    });
    const scheduleState = { nightly: { nextFireAt: "2026-06-23T10:07:00.000Z" } };
    expect(scheduleNextRunLabel(sched, scheduleState, now)).toBe("next in 7m");
    const row = rowsForTab("triggers", data({ triggers: [sched] }))[0]!;
    const lines = renderRowLines(row, false, 80, scheduleState, now);
    expect(lines).toHaveLength(2);
    expect(strip(lines[0]!)).toContain("nightly");
    const rendered = strip(renderRow(row, false, 80, scheduleState, now));
    expect(rendered).toContain("schedule");
    expect(rendered).toContain("every 5m");
    expect(rendered).toContain("next in 7m");
  });

  test("active binding rows are kept to one logical line", () => {
    const row = rowsForTab(
      "active",
      data({
        bindings: [
          binding({
            id: "router.pr",
            subjectKey: "github:pull_request:Digitech-AS/digitech-next#1596",
            target: { kind: "hive", handle: "digitech-pr-1596-correctness-with-a-very-long-name" },
          }),
        ],
      }),
    )[0]!;
    const lines = renderRowLines(row, true, 44);
    expect(lines).toHaveLength(1);
    expect(strip(lines[0]!).length).toBeLessThanOrEqual(44);
  });

  test("schedule row timing falls back for every schedules before daemon state exists", () => {
    const now = new Date("2026-06-23T10:00:00.000Z");
    const sched = trigger({
      id: "fresh",
      source: { kind: "schedule", timing: { type: "every", interval: "5m" } },
    });
    expect(scheduleNextRunLabel(sched, {}, now)).toBe("next in 5m");
  });
});

describe("schedule form round-trip", () => {
  test("every round-trips and validates the duration", () => {
    const form = scheduleTimingToForm({ type: "every", interval: "5m" });
    expect(form.type).toBe("every");
    expect(formToScheduleTiming(form)).toEqual({ type: "every", interval: "5m" });
    expect(() => formToScheduleTiming({ ...form, interval: "sometimes" })).toThrow(/Invalid duration/);
  });

  test("cron round-trips with optional timezone", () => {
    const form = scheduleTimingToForm({ type: "cron", expression: "0 8 * * 1-5", timezone: "Europe/Oslo" });
    expect(formToScheduleTiming(form)).toEqual({ type: "cron", expression: "0 8 * * 1-5", timezone: "Europe/Oslo" });
    expect(() => formToScheduleTiming({ ...form, expression: "  " })).toThrow(/cron expression/);
  });

  test("once validates the ISO date", () => {
    const form = scheduleTimingToForm({ type: "once", at: "2026-07-01T09:00:00Z" });
    expect(formToScheduleTiming(form).type).toBe("once");
    expect(() => formToScheduleTiming({ ...form, at: "not-a-date" })).toThrow(/Invalid ISO date/);
  });
});

describe("sidebar pane wiring", () => {
  test("clampSidebarWidth bounds the width", () => {
    expect(clampSidebarWidth(1)).toBe(24);
    expect(clampSidebarWidth(999)).toBe(90);
    expect(clampSidebarWidth(56)).toBe(56);
    expect(clampSidebarWidth(undefined)).toBe(56);
  });

  test("split argv puts the strip on the RIGHT (no -b) with the right width", () => {
    const argv = __testOnlySplitArgs("work:1", 60, "pol sidebar --sidebar");
    expect(argv).not.toContain("-b"); // right edge, not before/left
    expect(argv).toContain("-h");
    expect(argv).toContain("-f");
    expect(argv.slice(argv.indexOf("-l"), argv.indexOf("-l") + 2)).toEqual(["-l", "60"]);
    expect(argv).toContain("=work:1");
    expect(argv[argv.length - 1]).toBe("pol sidebar --sidebar");
  });

  test("sidebarCommand honours the env override", () => {
    const previous = process.env.POL_SIDEBAR_COMMAND;
    process.env.POL_SIDEBAR_COMMAND = "custom-cmd --x";
    try {
      expect(sidebarCommand()).toBe("custom-cmd --x");
    } finally {
      if (previous === undefined) delete process.env.POL_SIDEBAR_COMMAND;
      else process.env.POL_SIDEBAR_COMMAND = previous;
    }
  });

  test("sidebarCommand emits an absolute node invocation, never a bare `pol`", () => {
    // Regression: a symlinked `pol` bin reports an argv[1] that does not end in
    // cli.js, which used to fall through to a bare `pol` the tmux server's PATH
    // could not resolve → the pane died with exit 127.
    const previousEnv = process.env.POL_SIDEBAR_COMMAND;
    const previousArgv = process.argv[1];
    delete process.env.POL_SIDEBAR_COMMAND;
    process.argv[1] = "/opt/homebrew/bin/pol"; // symlink path, not *.js
    try {
      const command = sidebarCommand();
      expect(command.startsWith(`${process.execPath} `)).toBe(true);
      expect(command).toContain("/opt/homebrew/bin/pol");
      expect(command.endsWith(" sidebar --sidebar")).toBe(true);
      expect(command.startsWith("pol ")).toBe(false);
    } finally {
      if (previousEnv === undefined) delete process.env.POL_SIDEBAR_COMMAND;
      else process.env.POL_SIDEBAR_COMMAND = previousEnv;
      process.argv[1] = previousArgv;
    }
  });
});

describe("fireTriggerNow", () => {
  test("queues, runs, and returns a terminal job", async () => {
    await withTempStore(async (store) => {
      const t = trigger({ id: "emit-now", action: { kind: "emit", subject: "x", payload: "{{event}}" } });
      await store.saveTrigger(t);
      const job = await fireTriggerNow(store, t, { hi: 1 });
      expect(job.triggerId).toBe("emit-now");
      expect(job.status).toBe("completed");
      const stored = await store.listJobs();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.status).toBe("completed");
    });
  });
});
