/**
 * `pol sidebar` — the raw-mode TUI render loop.
 *
 * Presentation + interaction only (same discipline as honeybee's beesTui): the
 * caller injects data loading and every side effect via {@link SidebarDeps}, so
 * this module never imports the store or executor and the dependency direction
 * stays cli → sidebarTui. Pure helpers (tab model, row mapping, signature,
 * schedule-form round-trip) are exported for unit tests.
 */

import * as readline from "node:readline";
import { parseDuration } from "./time.js";
import { SIDEBAR_TABS, type SidebarTab } from "./sidebar.js";
import {
  c,
  jobBadge,
  relativeTime,
  sourceLabel,
  statusDot,
  strip,
  sym,
  truncate,
} from "./ui.js";
import type { Job, RouterBinding, ScheduleTiming, Trigger } from "./types.js";

const TERMINAL_STATUSES = new Set(["completed", "errored", "timed-out", "cancelled"]);

export const TAB_LABEL: Record<SidebarTab, string> = {
  triggers: "triggers",
  active: "active",
  history: "history",
};

export function nextTab(tab: SidebarTab, delta: number): SidebarTab {
  const n = SIDEBAR_TABS.length;
  const i = SIDEBAR_TABS.indexOf(tab);
  return SIDEBAR_TABS[(((i < 0 ? 0 : i) + delta) % n + n) % n]!;
}

export type SidebarData = {
  triggers: Trigger[];
  /** Non-terminal jobs (queued / resolving-context / running). */
  active: Job[];
  /** Terminal jobs, newest first. */
  history: Job[];
  /** Router bindings; active/pending ones surface as live hive work. */
  bindings: RouterBinding[];
};

export type SidebarRow =
  | { kind: "trigger"; id: string; trigger: Trigger; searchText: string }
  | { kind: "job"; id: string; job: Job; hiveHandle?: string; searchText: string }
  | { kind: "binding"; id: string; binding: RouterBinding; hiveHandle?: string; searchText: string };

/** Pull a hive target handle off a job's spawn result, if present. */
export function jobHiveHandle(job: Job): string | undefined {
  const result = job.result as { handle?: unknown; handles?: Record<string, unknown> } | undefined;
  if (result && typeof result.handle === "string") return result.handle;
  if (result?.handles) {
    const first = Object.values(result.handles).find((v) => typeof v === "string");
    if (typeof first === "string") return first;
  }
  return undefined;
}

export function rowsForTab(tab: SidebarTab, data: SidebarData): SidebarRow[] {
  if (tab === "triggers") {
    return data.triggers.map((trigger) => ({
      kind: "trigger" as const,
      id: trigger.id,
      trigger,
      searchText: `${trigger.id} ${trigger.name} ${trigger.source.kind} ${trigger.tags.join(" ")}`.toLowerCase(),
    }));
  }
  if (tab === "active") {
    const jobs: SidebarRow[] = data.active.map((job) => ({
      kind: "job" as const,
      id: job.id,
      job,
      hiveHandle: jobHiveHandle(job),
      searchText: `${job.id} ${job.triggerId} ${job.status}`.toLowerCase(),
    }));
    const bindings: SidebarRow[] = data.bindings
      .filter((b) => b.status === "active" || b.status === "pending" || b.status === "closing")
      .map((binding) => ({
        kind: "binding" as const,
        id: binding.id,
        binding,
        hiveHandle: binding.target?.handle,
        searchText: `${binding.id} ${binding.triggerId} ${binding.subjectKey} ${binding.target?.handle ?? ""}`.toLowerCase(),
      }));
    return [...jobs, ...bindings];
  }
  return data.history.map((job) => ({
    kind: "job" as const,
    id: job.id,
    job,
    hiveHandle: jobHiveHandle(job),
    searchText: `${job.id} ${job.triggerId} ${job.status}`.toLowerCase(),
  }));
}

/** A stable fingerprint so the poll loop only redraws on a real change. */
export function sidebarSignature(data: SidebarData): string {
  const t = data.triggers.map((x) => `${x.id}:${x.enabled ? 1 : 0}:${x.updatedAt}`).join(",");
  const a = data.active.map((x) => `${x.id}:${x.status}`).join(",");
  const h = data.history.map((x) => `${x.id}:${x.status}`).join(",");
  const b = data.bindings.map((x) => `${x.id}:${x.status}:${x.target?.handle ?? ""}`).join(",");
  return `${t}|${a}|${h}|${b}`;
}

export function filterRows(rows: SidebarRow[], query: string): SidebarRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const terms = q.split(/\s+/);
  return rows.filter((row) => terms.every((term) => row.searchText.includes(term)));
}

// --- schedule edit form round-trip (pure, tested) -------------------------

export type ScheduleFormValues = { type: string; expression: string; interval: string; at: string; timezone: string };

export function scheduleTimingToForm(timing: ScheduleTiming | undefined): ScheduleFormValues {
  return {
    type: timing?.type ?? "every",
    expression: timing?.type === "cron" ? timing.expression : "",
    interval: timing?.type === "every" ? timing.interval : "",
    at: timing?.type === "once" ? timing.at : "",
    timezone: timing?.type === "cron" ? timing.timezone ?? "" : "",
  };
}

export function formToScheduleTiming(values: ScheduleFormValues): ScheduleTiming {
  const type = values.type.trim();
  if (type === "every") {
    parseDuration(values.interval.trim()); // throws on a bad duration
    return { type: "every", interval: values.interval.trim() };
  }
  if (type === "once") {
    if (Number.isNaN(Date.parse(values.at.trim()))) throw new Error(`Invalid ISO date: ${values.at}`);
    return { type: "once", at: values.at.trim() };
  }
  if (type === "cron") {
    if (!values.expression.trim()) throw new Error("cron expression is required");
    return { type: "cron", expression: values.expression.trim(), ...(values.timezone.trim() ? { timezone: values.timezone.trim() } : {}) };
  }
  throw new Error(`Unknown schedule type "${type}" (use cron | every | once)`);
}

// --- injected dependencies (all side effects) -----------------------------

export type NewTriggerDraft = {
  name: string;
  sourceKind: "manual" | "schedule" | "webhook";
  scheduleType: string;
  scheduleValue: string;
  webhookPath: string;
  actionKind: "command" | "honeybee";
  command: string;
  bee: string;
};

export type SidebarDeps = {
  /** Long-running pane (Enter stays open) vs one-shot picker. */
  sidebar: boolean;
  initialTab: SidebarTab;
  loadData: () => Promise<SidebarData>;
  /** Poll the persisted active tab so sibling sidebars live-update. */
  syncTab?: () => Promise<SidebarTab | undefined>;
  onTabChange?: (tab: SidebarTab) => void | Promise<void>;
  renderTriggerPreview: (trigger: Trigger) => string;
  renderJobPreview: (job: Job) => string;
  renderBindingPreview: (binding: RouterBinding) => string;
  runNow: (trigger: Trigger, payloadJson: string) => Promise<string>;
  toggleEnabled: (trigger: Trigger) => Promise<string>;
  cancelJob: (job: Job) => Promise<string>;
  saveSchedule: (trigger: Trigger, timing: ScheduleTiming) => Promise<string>;
  createTrigger: (draft: NewTriggerDraft) => Promise<string>;
  duplicateJob: (job: Job, payloadJson: string) => Promise<string>;
  hiveJump: (handle: string) => Promise<string>;
  spawnHiveAuthor: (trigger?: Trigger) => Promise<string>;
};

type Field = { key: string; label: string; value: string; hint?: string };

type Dialog =
  | { kind: "preview"; title: string; lines: string[]; scroll: number }
  | { kind: "help"; scroll: number }
  | { kind: "form"; title: string; fields: Field[]; index: number; submit: (values: Record<string, string>) => Promise<string>; footer?: string }
  | { kind: "confirm"; title: string; message: string; confirm: () => Promise<string> };

export async function runSidebarTui(deps: SidebarDeps): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("pol sidebar requires a TTY. Bind it to a tmux pane or run interactively.");
  }
  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRaw = stdin.isRaw;

  let data: SidebarData = await deps.loadData();
  let tab: SidebarTab = deps.initialTab;
  let rows = rowsForTab(tab, data);
  let query = "";
  let filtering = false;
  let cursor = 0;
  let scroll = 0;
  let message = "↑↓ move · ←→ tab · tab previews · n new · r run · e edit · ? help · q quit";
  let busy = false;
  let dialog: Dialog | undefined;

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[?25l");

  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    stdout.write("\x1b[?25h\x1b[?1049l");
    stdin.setRawMode(previousRaw);
    stdin.pause();
  };
  const onSignal = (signal: NodeJS.Signals) => {
    restoreTerminal();
    process.exit(signal === "SIGTERM" ? 143 : 129);
  };
  process.once("exit", restoreTerminal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  try {
    await new Promise<void>((resolve) => {
      let done = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (pollTimer) clearInterval(pollTimer);
        stdin.off("keypress", onKey);
        stdout.off("resize", onResize);
        resolve();
      };

      const reslice = (keepId?: string) => {
        rows = filterRows(rowsForTab(tab, data), query);
        if (keepId) {
          const idx = rows.findIndex((r) => r.id === keepId);
          cursor = idx >= 0 ? idx : Math.min(cursor, Math.max(0, rows.length - 1));
        } else {
          cursor = Math.min(cursor, Math.max(0, rows.length - 1));
        }
      };

      const currentRow = (): SidebarRow | undefined => rows[cursor];

      const switchTab = (delta: number) => {
        tab = nextTab(tab, delta);
        query = "";
        filtering = false;
        cursor = 0;
        scroll = 0;
        reslice();
        message = `tab: ${TAB_LABEL[tab]}`;
        render();
        void deps.onTabChange?.(tab);
      };

      const step = (delta: number) => {
        if (rows.length === 0) return;
        cursor = Math.max(0, Math.min(rows.length - 1, cursor + delta));
        render();
      };

      const flash = (msg: string) => {
        message = msg;
        if (!done) render();
      };

      /** Run an injected side effect, guarding against overlap and reloading after. */
      const act = async (label: string, fn: () => Promise<string>) => {
        if (busy) return;
        busy = true;
        message = label;
        render();
        try {
          const result = await fn();
          data = await deps.loadData();
          reslice(currentRow()?.id);
          message = result;
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        } finally {
          busy = false;
          if (!done) render();
        }
      };

      const openPreview = () => {
        const row = currentRow();
        if (!row) return;
        const text =
          row.kind === "trigger" ? deps.renderTriggerPreview(row.trigger)
          : row.kind === "job" ? deps.renderJobPreview(row.job)
          : deps.renderBindingPreview(row.binding);
        const title = row.kind === "trigger" ? row.trigger.id : row.id;
        dialog = { kind: "preview", title, lines: text.split("\n"), scroll: 0 };
        render();
      };

      const openEditSchedule = () => {
        const row = currentRow();
        if (row?.kind !== "trigger") { flash("edit schedule: select a trigger"); return; }
        if (row.trigger.source.kind !== "schedule") { flash("edit schedule: trigger is not a schedule"); return; }
        const trigger = row.trigger;
        const form = scheduleTimingToForm(trigger.source.kind === "schedule" ? trigger.source.timing : undefined);
        dialog = {
          kind: "form",
          title: `edit schedule · ${trigger.id}`,
          footer: "type: cron | every | once",
          index: 0,
          fields: [
            { key: "type", label: "type", value: form.type, hint: "cron | every | once" },
            { key: "expression", label: "cron", value: form.expression, hint: "e.g. 0 8 * * 1-5" },
            { key: "interval", label: "every", value: form.interval, hint: "e.g. 30s, 5m, 1h" },
            { key: "at", label: "once at", value: form.at, hint: "ISO timestamp" },
            { key: "timezone", label: "timezone", value: form.timezone, hint: "cron only (optional)" },
          ],
          submit: async (values) => {
            const timing = formToScheduleTiming(values as ScheduleFormValues);
            return deps.saveSchedule(trigger, timing);
          },
        };
        render();
      };

      const openCreate = () => {
        dialog = {
          kind: "form",
          title: "new trigger",
          footer: "source: manual | schedule | webhook · action: command | honeybee",
          index: 0,
          fields: [
            { key: "name", label: "name", value: "", hint: "human name (id is slugified)" },
            { key: "sourceKind", label: "source", value: "schedule", hint: "manual | schedule | webhook" },
            { key: "scheduleType", label: "sched type", value: "every", hint: "cron | every | once" },
            { key: "scheduleValue", label: "sched value", value: "5m", hint: "interval / cron expr / ISO" },
            { key: "webhookPath", label: "hook path", value: "", hint: "webhook source only" },
            { key: "actionKind", label: "action", value: "command", hint: "command | honeybee" },
            { key: "command", label: "command", value: "", hint: "command action only" },
            { key: "bee", label: "bee", value: "codex", hint: "honeybee spawn only" },
          ],
          submit: async (values) =>
            deps.createTrigger({
              name: values.name,
              sourceKind: values.sourceKind as NewTriggerDraft["sourceKind"],
              scheduleType: values.scheduleType,
              scheduleValue: values.scheduleValue,
              webhookPath: values.webhookPath,
              actionKind: values.actionKind as NewTriggerDraft["actionKind"],
              command: values.command,
              bee: values.bee,
            }),
        };
        render();
      };

      const openRunNow = () => {
        const row = currentRow();
        if (row?.kind !== "trigger") { flash("run now: select a trigger"); return; }
        const trigger = row.trigger;
        dialog = {
          kind: "form",
          title: `run now · ${trigger.id}`,
          footer: "fires immediately with this JSON payload",
          index: 0,
          fields: [{ key: "payload", label: "payload", value: "{}", hint: "JSON" }],
          submit: async (values) => deps.runNow(trigger, values.payload || "{}"),
        };
        render();
      };

      const openDuplicate = () => {
        const row = currentRow();
        if (row?.kind !== "job") { flash("duplicate: select a job"); return; }
        const job = row.job;
        const prefill = job.batch && job.batch.length ? JSON.stringify(job.batch[0]) : "{}";
        dialog = {
          kind: "form",
          title: `duplicate job · ${job.triggerId}`,
          footer: "re-fires the job's trigger with this payload",
          index: 0,
          fields: [{ key: "payload", label: "payload", value: prefill, hint: "JSON" }],
          submit: async (values) => deps.duplicateJob(job, values.payload || "{}"),
        };
        render();
      };

      const doToggle = () => {
        const row = currentRow();
        if (row?.kind !== "trigger") { flash("toggle: select a trigger"); return; }
        void act(`toggling ${row.trigger.id}…`, () => deps.toggleEnabled(row.trigger));
      };

      const doCancel = () => {
        const row = currentRow();
        if (row?.kind !== "job") { flash("cancel: select a job"); return; }
        const job = row.job;
        if (TERMINAL_STATUSES.has(job.status)) { flash("cancel: job already finished"); return; }
        dialog = {
          kind: "confirm",
          title: "cancel job",
          message: `Cancel job ${job.id} (${job.triggerId})?`,
          confirm: () => deps.cancelJob(job),
        };
        render();
      };

      const doHiveJump = () => {
        const row = currentRow();
        const handle = row && "hiveHandle" in row ? row.hiveHandle : undefined;
        if (!handle) {
          if (row?.kind === "trigger") openPreview();
          else flash("no hive target on this row");
          return;
        }
        void act(`jumping to ${handle}…`, () => deps.hiveJump(handle));
      };

      const doSpawnHiveAuthor = () => {
        const row = currentRow();
        const trigger = row?.kind === "trigger" ? row.trigger : undefined;
        void act("spawning hive authoring session…", () => deps.spawnHiveAuthor(trigger));
      };

      const submitForm = async (form: Extract<Dialog, { kind: "form" }>) => {
        if (busy) return;
        const values = Object.fromEntries(form.fields.map((f) => [f.key, f.value.trim()]));
        busy = true;
        message = "saving…";
        render();
        try {
          const result = await form.submit(values);
          data = await deps.loadData();
          dialog = undefined;
          reslice(currentRow()?.id);
          message = result;
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        } finally {
          busy = false;
          if (!done) render();
        }
      };

      const onDialogKey = (value: string, key: readline.Key) => {
        const d = dialog!;
        if (key.name === "escape") { dialog = undefined; flash("cancelled"); return; }
        if (d.kind === "preview" || d.kind === "help") {
          if (key.name === "up" || key.name === "k") { d.scroll = Math.max(0, d.scroll - 1); render(); return; }
          if (key.name === "down" || key.name === "j") { d.scroll += 1; render(); return; }
          if (key.name === "q" || key.name === "return" || key.name === "tab") { dialog = undefined; render(); return; }
          return;
        }
        if (d.kind === "confirm") {
          if (busy) return;
          if (key.name === "y" || key.name === "return" || key.name === "enter") {
            void (async () => {
              busy = true; message = "working…"; render();
              try {
                const result = await d.confirm();
                data = await deps.loadData();
                dialog = undefined; reslice(currentRow()?.id); message = result;
              } catch (error) {
                message = error instanceof Error ? error.message : String(error);
              } finally { busy = false; if (!done) render(); }
            })();
          } else { dialog = undefined; flash("cancelled"); }
          return;
        }
        // form
        if (busy) return;
        if (key.name === "up" || (key.shift && key.name === "tab")) { d.index = (d.index - 1 + d.fields.length) % d.fields.length; render(); return; }
        if (key.name === "down" || key.name === "tab") { d.index = (d.index + 1) % d.fields.length; render(); return; }
        if (key.name === "return" || key.name === "enter") { void submitForm(d); return; }
        const field = d.fields[d.index]!;
        if (key.name === "backspace") { field.value = field.value.slice(0, -1); render(); return; }
        if (value && !key.ctrl && !key.meta && value.length === 1 && value >= " ") { field.value += value; render(); return; }
      };

      const onKey = (value: string, key: readline.Key) => {
        if (key.ctrl && key.name === "c") { finish(); return; }
        if (dialog) { onDialogKey(value, key); return; }
        if (busy) return;
        if (filtering) {
          if (key.name === "escape") { query = ""; filtering = false; reslice(); flash("filter cleared"); return; }
          if (key.name === "return" || key.name === "enter") { filtering = false; flash(`filter: ${query || "(none)"}`); return; }
          if (key.name === "backspace") { query = query.slice(0, -1); reslice(); render(); return; }
          if (value && !key.ctrl && !key.meta && value.length === 1 && value >= " ") { query += value; reslice(); render(); return; }
          return;
        }
        if (key.name === "escape" || (key.name === "q")) { finish(); return; }
        if (key.name === "up" || (key.ctrl && key.name === "p") || key.name === "k") { step(-1); return; }
        if (key.name === "down" || (key.ctrl && key.name === "n") || key.name === "j") { step(1); return; }
        if (key.name === "left" || (key.shift && key.name === "tab")) { switchTab(-1); return; }
        if (key.name === "right") { switchTab(1); return; }
        if (key.name === "tab") { openPreview(); return; }
        if (key.name === "return" || key.name === "enter") { doHiveJump(); return; }
        if (value === "/") { filtering = true; query = ""; flash("filter: "); return; }
        if (value === "?") { dialog = { kind: "help", scroll: 0 }; render(); return; }
        if (value === "n") { openCreate(); return; }
        if (value === "e") { openEditSchedule(); return; }
        if (value === "r") { openRunNow(); return; }
        if (value === "d") { openDuplicate(); return; }
        if (value === "t") { doToggle(); return; }
        if (value === "c") { doCancel(); return; }
        if (value === "H") { doSpawnHiveAuthor(); return; }
      };

      const render = () => {
        if (done) return;
        const width = Math.max(20, stdout.columns || 80);
        const height = Math.max(10, stdout.rows || 24);
        const lines: string[] = [renderTabBar(tab, width), ""];
        const bodyRows = Math.max(3, height - 5);
        if (dialog) {
          lines.push(...renderDialog(dialog, width, bodyRows));
        } else {
          if (cursor < scroll) scroll = cursor;
          if (cursor >= scroll + bodyRows) scroll = cursor - bodyRows + 1;
          scroll = Math.min(scroll, Math.max(0, rows.length - bodyRows));
          if (rows.length === 0) {
            lines.push(c.dim(tab === "triggers" ? "  no triggers — press n to create one" : tab === "active" ? "  no active jobs" : "  no history yet"));
            for (let i = 1; i < bodyRows; i += 1) lines.push("");
          } else {
            const visible = rows.slice(scroll, scroll + bodyRows);
            for (let i = 0; i < visible.length; i += 1) lines.push(renderRow(visible[i]!, scroll + i === cursor, width));
            for (let i = visible.length; i < bodyRows; i += 1) lines.push("");
          }
        }
        lines.push(truncate(filtering ? c.cyan(`/${query}`) : message, width));
        lines.push(c.dim(truncate(footerHint(), width)));
        stdout.write(`\x1b[2J\x1b[H${lines.map((line) => clampLine(line, width)).join("\n")}`);
      };

      const footerHint = (): string => {
        if (dialog?.kind === "form") return `${dialog.footer ? dialog.footer + " · " : ""}↑↓ field · enter save · esc cancel`;
        if (dialog?.kind === "confirm") return "y confirm · n/esc cancel";
        if (dialog) return "↑↓ scroll · q/esc close";
        if (filtering) return "type to filter · enter apply · esc clear";
        return `${deps.sidebar ? "sidebar" : "picker"} · tab preview · enter hive · n e r d t c H · / filter`;
      };

      const onResize = () => render();

      render();
      stdin.on("keypress", onKey);
      stdout.on("resize", onResize);

      let refreshing = false;
      let tick = 0;
      let lastSignature = sidebarSignature(data);
      pollTimer = setInterval(() => {
        tick += 1;
        if (deps.syncTab) {
          void deps.syncTab().then((next) => {
            if (done || dialog || busy || !next || next === tab) return;
            tab = next;
            query = "";
            filtering = false;
            cursor = 0;
            scroll = 0;
            reslice();
            render();
          });
        }
        if (tick % 2 === 0 && !refreshing) {
          refreshing = true;
          void deps
            .loadData()
            .then((next) => {
              if (done || dialog || busy) return;
              const signature = sidebarSignature(next);
              if (signature === lastSignature) return;
              lastSignature = signature;
              data = next;
              reslice(currentRow()?.id);
              render();
            })
            .catch(() => {})
            .finally(() => { refreshing = false; });
        }
      }, 1500);
    });
  } finally {
    process.off("exit", restoreTerminal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    restoreTerminal();
  }
}

// --- rendering -------------------------------------------------------------

function renderTabBar(active: SidebarTab, width: number): string {
  const cells = SIDEBAR_TABS.map((tab) => {
    const label = ` ${TAB_LABEL[tab]} `;
    return tab === active ? c.inverse(c.bold(label)) : c.dim(label);
  });
  const head = `${c.accent(sym.flower)} ${c.bold("pollinate")}`;
  return truncate(`${head}  ${cells.join(c.dim("·"))}`, width);
}

function renderRow(row: SidebarRow, selected: boolean, width: number): string {
  const cursor = selected ? c.accent(sym.bee) : " ";
  let body: string;
  if (row.kind === "trigger") {
    const t = row.trigger;
    body = `${statusDot(t.enabled)} ${c.bold(truncate(t.id, Math.max(8, width - 28)))} ${c.dim(sym.mid)} ${sourceLabel(t.source.kind)}`;
  } else if (row.kind === "job") {
    const j = row.job;
    const handle = row.hiveHandle ? ` ${c.magenta(sym.bee)}` : "";
    body = `${jobBadge(j.status)} ${c.bold(truncate(j.triggerId, Math.max(8, width - 30)))}${handle} ${c.dim(relativeTime(j.queuedAt))}`;
  } else {
    const b = row.binding;
    const handle = b.target?.handle ? ` ${c.magenta(b.target.handle)}` : "";
    body = `${c.cyan(sym.gear)} ${c.bold(truncate(b.subjectKey, Math.max(8, width - 30)))}${handle} ${c.dim(b.status)}`;
  }
  const line = `${cursor} ${body}`;
  return selected ? c.accent(strip(line)) : line;
}

function blanks(n: number): string[] {
  return Array.from({ length: Math.max(0, n) }, () => "");
}

function renderDialog(dialog: Dialog, width: number, bodyRows: number): string[] {
  if (dialog.kind === "preview") {
    const head = `${c.accent(sym.flower)} ${c.bold(truncate(dialog.title, width - 4))}`;
    const window = dialog.lines.slice(dialog.scroll, dialog.scroll + bodyRows - 1);
    return [head, ...window, ...blanks(bodyRows - 1 - window.length)];
  }
  if (dialog.kind === "help") {
    const window = HELP_LINES.slice(dialog.scroll, dialog.scroll + bodyRows - 1);
    return [c.bold("keys"), ...window, ...blanks(bodyRows - 1 - window.length)];
  }
  if (dialog.kind === "confirm") {
    return [`${c.yellow(sym.warn)} ${c.bold(dialog.title)}`, "", `  ${dialog.message}`, ...blanks(bodyRows - 3)];
  }
  // form
  const lines = [`${c.accent(sym.flower)} ${c.bold(truncate(dialog.title, width - 4))}`, ""];
  const labelWidth = Math.max(...dialog.fields.map((f) => f.label.length));
  dialog.fields.forEach((field, i) => {
    const marker = i === dialog.index ? c.accent(sym.bee) : " ";
    const label = c.dim(field.label.padEnd(labelWidth));
    const value = i === dialog.index ? `${field.value}${c.accent("▏")}` : field.value || c.dim(field.hint ? `(${field.hint})` : "");
    lines.push(`${marker} ${label}  ${truncate(value, Math.max(4, width - labelWidth - 5))}`);
  });
  while (lines.length < bodyRows) lines.push("");
  return lines;
}

const HELP_LINES = [
  "↑/↓ or j/k   move cursor",
  "←/→          switch tab (triggers/active/history)",
  "tab          preview the highlighted row",
  "enter        jump to the row's hive bee (or preview a trigger)",
  "n            new trigger (form)",
  "e            edit schedule (form)",
  "r            run now (fire a trigger with a payload)",
  "d            duplicate a job and re-fire with an edited payload",
  "t            toggle a trigger enabled/disabled",
  "c            cancel a running job",
  "H            spawn a hive session to author a trigger",
  "/            filter rows (enter applies, esc clears)",
  "?            this help · q/esc closes / quits",
];

/** Truncate to width while leaving ANSI intact (truncate is ANSI-aware in ui.ts). */
function clampLine(line: string, width: number): string {
  return truncate(line, width);
}
