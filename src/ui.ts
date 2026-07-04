// Terminal styling, symbols, and layout primitives for the pollinate CLI.
//
// Everything here degrades gracefully: when output is piped, NO_COLOR is set,
// or the terminal is dumb, styling collapses to plain text and symbols fall
// back to ASCII. The CLI's machine-readable `--json` path never touches this
// module, so structured output stays byte-stable.

import type { Source } from "./types.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_AT_RE = /\x1b\[[0-?]*[ -/]*[@-~]/y;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

type Stream = NodeJS.WriteStream | { isTTY?: boolean };
type GraphemeSegment = { segment: string };
type GraphemeSegmenter = { segment(input: string): Iterable<GraphemeSegment> };

const SegmenterCtor = (Intl as typeof Intl & {
  Segmenter?: new (locale: string | undefined, options: { granularity: "grapheme" }) => GraphemeSegmenter;
}).Segmenter;
const GRAPHEME_SEGMENTER = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: "grapheme" }) : undefined;

export function detectColorLevel(env: NodeJS.ProcessEnv = process.env, stream: Stream = process.stdout): 0 | 1 | 2 | 3 {
  const { FORCE_COLOR, POLLINATE_FORCE_COLOR, NO_COLOR, POLLINATE_NO_COLOR, COLORTERM, TERM, TMUX } = env;
  const forced = POLLINATE_FORCE_COLOR ?? FORCE_COLOR;
  if (forced !== undefined) {
    if (forced === "" || forced === "0" || forced === "false") {
      if (POLLINATE_FORCE_COLOR !== undefined || !TMUX) return 0;
    } else if (forced === "1") return 1;
    else if (forced === "2") return 2;
    else return 3;
  }
  if (POLLINATE_NO_COLOR !== undefined && POLLINATE_NO_COLOR !== "") return 0;
  // NO_COLOR often leaks from non-interactive Codex/tooling parents into tmux.
  // Keep honoring it outside tmux; inside tmux use POLLINATE_NO_COLOR for an
  // intentional no-color override.
  if (!TMUX && NO_COLOR !== undefined && NO_COLOR !== "") return 0;
  if (!stream.isTTY) return 0;
  if (!TMUX && TERM === "dumb") return 0;
  if (COLORTERM && /truecolor|24bit/i.test(COLORTERM)) return 3;
  if (TERM && /256|truecolor/i.test(TERM)) return 2;
  if (TMUX) return 2;
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

function* graphemes(s: string): Iterable<string> {
  if (GRAPHEME_SEGMENTER) {
    for (const part of GRAPHEME_SEGMENTER.segment(s)) yield part.segment;
    return;
  }
  yield* Array.from(s);
}

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    cp === 0x05bf ||
    (cp >= 0x05c1 && cp <= 0x05c2) ||
    (cp >= 0x05c4 && cp <= 0x05c5) ||
    cp === 0x05c7 ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0670 && cp <= 0x0670) ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e4) ||
    (cp >= 0x06e7 && cp <= 0x06e8) ||
    (cp >= 0x06ea && cp <= 0x06ed) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6))
  );
}

function codePointWidth(cp: number): number {
  if (cp === 0 || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isCombining(cp)) return 0;
  return isWideCodePoint(cp) ? 2 : 1;
}

function graphemeWidth(segment: string): number {
  if (EMOJI_RE.test(segment)) return 2;
  let n = 0;
  for (const ch of segment) n += codePointWidth(ch.codePointAt(0)!);
  return n;
}

function ansiAt(s: string, index: number): string | undefined {
  ANSI_AT_RE.lastIndex = index;
  return ANSI_AT_RE.exec(s)?.[0];
}

/** Visible width of a string, ignoring ANSI escape sequences. */
export function width(s: string): number {
  let n = 0;
  for (const segment of graphemes(strip(s))) n += graphemeWidth(segment);
  return n;
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

/** Truncate to a visible width, preserving ANSI escape sequences. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  const ellipsis = UNICODE ? "…" : "~";
  const budget = Math.max(0, max - width(ellipsis));
  let visible = 0;
  let out = "";
  let sawAnsi = false;

  for (let i = 0; i < s.length;) {
    const ansi = ansiAt(s, i);
    if (ansi) {
      out += ansi;
      sawAnsi = true;
      i += ansi.length;
      continue;
    }

    const nextAnsi = s.indexOf("\x1b[", i);
    const plainEnd = nextAnsi >= 0 ? nextAnsi : s.length;
    const chunk = s.slice(i, plainEnd);
    for (const segment of graphemes(chunk)) {
      const segmentWidth = graphemeWidth(segment);
      if (visible + segmentWidth > budget) {
        return out + (sawAnsi ? "\x1b[0m" : "") + ellipsis;
      }
      out += segment;
      visible += segmentWidth;
    }
    i = plainEnd;
  }

  return out;
}

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

const SOURCE_COLOR: Record<string, (s: string) => string> = {
  schedule: c.cyan,
  webhook: c.magenta,
  poll: c.blue,
  manual: c.gray,
};

export function sourceLabel(kind: string): string {
  return (SOURCE_COLOR[kind] ?? c.gray)(kind);
}

export function sourceDetail(source: Source): string {
  switch (source.kind) {
    case "manual":
      return "on demand";
    case "schedule": {
      const timing = source.timing;
      if (timing.type === "every") return `every ${timing.interval}`;
      if (timing.type === "cron") return `cron ${timing.expression}${timing.timezone && timing.timezone !== "UTC" ? ` (${timing.timezone})` : ""}`;
      return `once at ${timing.at}`;
    }
    case "webhook":
      return `/hook/${source.webhook.path}${source.webhook.secret ? ` ${sym.mid} secured` : ""}`;
    case "poll":
      return `every ${source.poll.interval} ${sym.mid} ${source.poll.fetch.kind}`;
    default:
      return "";
  }
}

/** Compact relative time, e.g. "2m ago", "in 3h", "just now". */
export function relativeTime(iso?: string | Date, now = new Date()): string {
  if (!iso) return c.dim("—");
  const then = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (Number.isNaN(then)) return iso instanceof Date ? String(iso) : iso;
  const diff = now.getTime() - then;
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
