/**
 * Minimal tmux helper for the `pol sidebar` TUI.
 *
 * Built on `execArgv` (no shell) so we never interpolate untrusted text into a
 * shell string — same discipline as the rest of pollinate. The only place a
 * shell command string is constructed is the argument to `split-window`, which
 * tmux itself runs; `formatShellCommand` quotes each part for that.
 */

import { execArgv } from "./process.js";

export type TmuxResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

/** True when running inside a tmux client/server (the sidebar needs one). */
export function insideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

/**
 * Run `tmux <args>`. By default failures resolve with `ok: false` rather than
 * throwing — tmux probes (list-panes against a window that may not exist) are
 * routinely best-effort. Pass `{ reject: true }` to throw on a non-zero exit.
 */
export async function tmux(args: string[], opts: { reject?: boolean } = {}): Promise<TmuxResult> {
  const result = await execArgv("tmux", args);
  const out: TmuxResult = {
    ok: result.exitCode === 0,
    code: result.exitCode,
    stdout: result.stdout.replace(/\n$/, ""),
    stderr: result.stderr.trim(),
  };
  if (!out.ok && opts.reject) {
    throw new Error(`tmux ${args.join(" ")} exited ${out.code}: ${out.stderr}`);
  }
  return out;
}

/**
 * Quote argv parts into a single shell command string for `tmux split-window` /
 * `new-window`, which spawn their argument through `/bin/sh -c`. Bare tokens are
 * passed through; anything with shell-significant characters is single-quoted.
 */
export function formatShellCommand(parts: string[]): string {
  return parts.map(quoteShellPart).join(" ");
}

function quoteShellPart(part: string): string {
  if (part.length > 0 && /^[A-Za-z0-9_./:=-]+$/.test(part)) return part;
  return `'${part.replace(/'/g, `'\\''`)}'`;
}
