// Terminal styling, symbols, and layout primitives for the pollinate CLI.
//
// Everything here degrades gracefully: when output is piped, NO_COLOR is set,
// or the terminal is dumb, styling collapses to plain text and symbols fall
// back to ASCII. The CLI's machine-readable `--json` path never touches this
// module, so structured output stays byte-stable.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function detectColorLevel(): 0 | 1 | 2 | 3 {
  const { FORCE_COLOR, NO_COLOR, COLORTERM, TERM } = process.env;
  if (FORCE_COLOR !== undefined) {
    if (FORCE_COLOR === "" || FORCE_COLOR === "0" || FORCE_COLOR === "false") return 0;
    if (FORCE_COLOR === "1") return 1;
    if (FORCE_COLOR === "2") return 2;
    return 3;
  }
  if (NO_COLOR !== undefined && NO_COLOR !== "") return 0;
  if (!process.stdout.isTTY) return 0;
  if (TERM === "dumb") return 0;
  if (COLORTERM && /truecolor|24bit/i.test(COLORTERM)) return 3;
  if (TERM && /256|truecolor/i.test(TERM)) return 2;
  return 1;
}

const COLOR_LEVEL = detectColorLevel();
const COLOR = COLOR_LEVEL > 0;
const UNICODE =
  !process.env.POLLINATE_ASCII && process.env.TERM !== "dumb" && process.env.TERM !== "linux";

function sgr(open: number, close: number): (s: string) => string {
  const prefix = `\x1b[${open}m`;
  const suffix = `\x1b[${close}m`;
  return (s: string) => (COLOR ? prefix + s + suffix : s);
}

/** Foreground styles. Honey/amber accent steps down 256→16 by terminal level. */
export const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  inverse: sgr(7, 27),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  /** Brand honey/amber — the pollinate accent. */
  accent(s: string): string {
    if (COLOR_LEVEL >= 2) return `\x1b[38;5;214m${s}\x1b[39m`;
    if (COLOR_LEVEL === 1) return `\x1b[33m${s}\x1b[39m`;
    return s;
  },
  /** Soft petal pink, used sparingly for the wordmark. */
  petal(s: string): string {
    if (COLOR_LEVEL >= 2) return `\x1b[38;5;211m${s}\x1b[39m`;
    if (COLOR_LEVEL === 1) return `\x1b[35m${s}\x1b[39m`;
    return s;
  },
};

export const sym = UNICODE
  ? {
      on: "●",
      off: "○",
      check: "✓",
      cross: "✗",
      dot: "•",
      mid: "·",
      arrow: "→",
      warn: "⚠",
      ban: "⊘",
      ring: "◌",
      gear: "◍",
      flower: "✿",
      bee: "❯",
      vline: "│",
      tee: "├",
      elbow: "└",
      hline: "─",
    }
  : {
      on: "*",
      off: "o",
      check: "+",
      cross: "x",
      dot: "-",
      mid: ".",
      arrow: "->",
      warn: "!",
      ban: "x",
      ring: "o",
      gear: "*",
      flower: "*",
      bee: ">",
      vline: "|",
      tee: "+",
      elbow: "+",
      hline: "-",
    };

/** Visible width of a string, ignoring ANSI escape sequences. */
export function width(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** Strip ANSI escape sequences. */
export function strip(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Pad to a visible width, accounting for embedded ANSI codes. */
export function pad(s: string, target: number, align: "left" | "right" = "left"): string {
  const len = width(s);
  if (len >= target) return s;
  const fill = " ".repeat(target - len);
  return align === "right" ? fill + s : s + fill;
}

/** Truncate to a visible width, appending an ellipsis. Safe on un-styled text. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  if (strip(s) !== s) return s; // never truncate mid-escape; styled cells stay intact
  return s.slice(0, Math.max(0, max - 1)) + (UNICODE ? "…" : "~");
}

const terminalWidth = (): number => process.stdout.columns || 80;

export type TableOptions = {
  head?: string[];
  align?: ("left" | "right")[];
  gap?: number;
  indent?: number;
};

/** Render aligned columns. Header (if any) is dimmed and upper-cased. */
export function table(rows: string[][], opts: TableOptions = {}): string {
  const gap = opts.gap ?? 2;
  const indent = " ".repeat(opts.indent ?? 2);
  const sep = " ".repeat(gap);
  const body = opts.head ? [opts.head, ...rows] : rows;
  const cols = Math.max(0, ...body.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < cols; i += 1) {
    widths[i] = Math.max(0, ...body.map((r) => width(r[i] ?? "")));
  }
  const render = (cells: string[], styler?: (s: string) => string): string => {
    const line = cells
      .map((cell, i) => {
        const isLast = i === cols - 1;
        const value = styler ? styler(cell) : cell;
        // Don't pad the final left-aligned column — avoids trailing spaces.
        if (isLast && (opts.align?.[i] ?? "left") === "left") return value;
        return pad(value, widths[i], opts.align?.[i] ?? "left");
      })
      .join(sep);
    return (indent + line).replace(/\s+$/, "");
  };
  const lines: string[] = [];
  if (opts.head) lines.push(render(opts.head, (s) => c.dim(c.bold(s.toUpperCase()))));
  for (const row of rows) lines.push(render(row));
  return lines.join("\n");
}

/** A rounded box around content lines, with an optional accented title. */
export function box(lines: string[], opts: { title?: string; pad?: number } = {}): string {
  const horizontalPad = opts.pad ?? 1;
  const title = opts.title ?? "";
  const inner = Math.max(
    title ? width(title) + 4 : 0,
    ...lines.map(width),
    0,
  );
  const innerPadded = inner + horizontalPad * 2;
  const h = sym.hline;
  const dash = (n: number) => c.dim(h.repeat(Math.max(0, n)));
  const top = title
    ? c.dim("╭" + h + " ") +
      c.accent(c.bold(title)) +
      " " +
      dash(innerPadded - 2 - width(title) - 1) +
      c.dim("╮")
    : c.dim("╭" + h.repeat(innerPadded) + "╮");
  const bottom = c.dim("╰" + h.repeat(innerPadded) + "╯");
  const space = " ".repeat(horizontalPad);
  const sides = lines.map(
    (line) => c.dim("│") + space + pad(line, inner) + space + c.dim("│"),
  );
  return [top, ...sides, bottom].join("\n");
}

/** Section heading: an accented flower glyph plus a bold title. */
export function heading(title: string): string {
  return `${c.accent(sym.flower)} ${c.bold(title)}`;
}

/** A "label: value" definition row, with the label dimmed and right-sized. */
export function field(label: string, value: string, labelWidth = 0): string {
  return `  ${c.dim(pad(label, labelWidth))}  ${value}`;
}

/** Render a list of [label, value] pairs as an aligned definition block. */
export function fields(pairs: Array<[string, string] | null | undefined>): string {
  const rows = pairs.filter(Boolean) as Array<[string, string]>;
  const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => field(label, value, labelWidth)).join("\n");
}

/** A horizontal rule spanning the terminal (capped), dimmed. */
export function rule(label?: string): string {
  const total = Math.min(terminalWidth(), 80);
  if (!label) return c.dim(sym.hline.repeat(total));
  const text = ` ${label} `;
  const remaining = Math.max(0, total - width(text));
  return c.dim(sym.hline.repeat(2)) + c.dim(text) + c.dim(sym.hline.repeat(remaining - 2));
}

/** Enabled/disabled dot for a trigger. */
export function statusDot(enabled: boolean): string {
  return enabled ? c.green(sym.on) : c.gray(sym.off);
}

type JobLook = { glyph: string; color: (s: string) => string };

const JOB_LOOK: Record<string, JobLook> = {
  completed: { glyph: sym.check, color: c.green },
  running: { glyph: sym.gear, color: c.yellow },
  "resolving-context": { glyph: sym.gear, color: c.cyan },
  queued: { glyph: sym.ring, color: c.blue },
  errored: { glyph: sym.cross, color: c.red },
  "timed-out": { glyph: sym.cross, color: c.red },
  cancelled: { glyph: sym.ban, color: c.gray },
};

/** A colored glyph + label for a job status. */
export function jobBadge(status: string): string {
  const look = JOB_LOOK[status] ?? { glyph: sym.dot, color: c.gray };
  return `${look.color(look.glyph)} ${look.color(status)}`;
}

/** Just the colored status word (for table cells where the glyph is separate). */
export function jobStatusColor(status: string): (s: string) => string {
  return (JOB_LOOK[status] ?? { color: c.gray }).color;
}

const SOURCE_COLOR: Record<string, (s: string) => string> = {
  schedule: c.cyan,
  webhook: c.magenta,
  poll: c.blue,
  manual: c.gray,
};

export function sourceLabel(kind: string): string {
  return (SOURCE_COLOR[kind] ?? c.gray)(kind);
}

/** Compact relative time, e.g. "2m ago", "in 3h", "just now". */
export function relativeTime(iso?: string): string {
  if (!iso) return c.dim("—");
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const future = diff < 0;
  const abs = Math.abs(diff);
  if (abs < 1_000) return "just now";
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  let text = "";
  for (const [ms, label] of units) {
    if (abs >= ms) {
      text = `${Math.floor(abs / ms)}${label}`;
      break;
    }
  }
  return future ? `in ${text}` : `${text} ago`;
}

/** Human duration for a millisecond span, e.g. "920ms", "1.4s", "2m 03s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * A self-clearing spinner. No-ops unless stdout is an interactive color TTY,
 * so it never corrupts piped or `--json` output. Returns a stop function.
 */
export function spinner(text: string): () => void {
  if (!COLOR || !process.stdout.isTTY) return () => {};
  const frames = UNICODE
    ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    : ["-", "\\", "|", "/"];
  let i = 0;
  process.stdout.write("\x1b[?25l");
  const timer = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r${c.accent(frames[i])} ${text}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K\x1b[?25h");
  };
}

/** Success / failure / warning / info one-liners. */
export const say = {
  ok: (s: string): string => `${c.green(sym.check)} ${s}`,
  fail: (s: string): string => `${c.red(sym.cross)} ${s}`,
  warn: (s: string): string => `${c.yellow(sym.warn)} ${s}`,
  info: (s: string): string => `${c.blue(sym.dot)} ${s}`,
  hint: (s: string): string => c.dim(`${sym.arrow} ${s}`),
};

/** The pollinate wordmark used in help and the empty invocation. */
export function banner(version: string): string {
  const mark = `${c.petal(sym.flower)} ${c.accent(c.bold("pollinate"))}`;
  const tag = c.dim("trigger substrate");
  return `${mark} ${c.dim(sym.mid)} ${tag} ${c.dim("v" + version)}`;
}

export const colorEnabled = COLOR;
