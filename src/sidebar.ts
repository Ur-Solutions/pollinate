/**
 * tmux RIGHT sidebar for `pol sidebar`: split wiring and global persistence.
 *
 * Ported from honeybee's `beesSidebar.ts`, with two differences: the strip lives
 * on the RIGHT edge (no `-b`/before flag), and the persisted facet is the active
 * tab rather than a grouping mode. A global `@pol_sidebar_width` option remembers
 * that the operator wants the strip.
 */

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatShellCommand, tmux } from "./tmux.js";

export const SIDEBAR_NAV_PANE_OPTION = "@pol_sidebar_nav";
export const SIDEBAR_WIDTH_OPTION = "@pol_sidebar_width";
export const SIDEBAR_TAB_OPTION = "@pol_sidebar_tab";

export const SIDEBAR_TABS = ["triggers", "active", "history"] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];

export function isSidebarTab(value: string | undefined): value is SidebarTab {
  return (SIDEBAR_TABS as readonly string[]).includes(value ?? "");
}

const DEFAULT_SIDEBAR_WIDTH = 56;
const MIN_SIDEBAR_WIDTH = 24;
const MAX_SIDEBAR_WIDTH = 90;

export function clampSidebarWidth(width: number | undefined): number {
  const raw = width ?? DEFAULT_SIDEBAR_WIDTH;
  if (!Number.isFinite(raw)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(raw)));
}

type PaneRow = { paneId: string; nav: boolean; active: boolean };

async function currentWindowTarget(): Promise<string> {
  const result = await tmux(["display-message", "-p", "#{session_name}:#{window_index}"]);
  const target = result.stdout.trim();
  if (!target || !target.includes(":")) throw new Error("Could not resolve the current tmux window");
  return target;
}

function exactWindowTarget(windowTarget: string): string {
  const i = windowTarget.indexOf(":");
  if (i < 0) return windowTarget.startsWith("=") ? windowTarget : `=${windowTarget}`;
  const session = windowTarget.slice(0, i);
  const rest = windowTarget.slice(i);
  return `${session.startsWith("=") ? session : `=${session}`}${rest}`;
}

async function listWindowPanes(windowTarget: string): Promise<PaneRow[]> {
  const format = `#{pane_id}\t#{${SIDEBAR_NAV_PANE_OPTION}}\t#{pane_active}`;
  const result = await tmux(["list-panes", "-t", exactWindowTarget(windowTarget), "-F", format]);
  if (!result.ok) return [];
  const rows: PaneRow[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, navRaw, activeRaw] = line.split("\t");
    if (!paneId) continue;
    rows.push({ paneId, nav: navRaw === "1", active: activeRaw === "1" });
  }
  return rows;
}

async function listAllNavPanes(): Promise<string[]> {
  const format = `#{pane_id}\t#{${SIDEBAR_NAV_PANE_OPTION}}`;
  const result = await tmux(["list-panes", "-a", "-F", format]);
  if (!result.ok) return [];
  const panes: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, navRaw] = line.split("\t");
    if (paneId && navRaw === "1") panes.push(paneId);
  }
  return panes;
}

async function setPaneOption(paneId: string, key: string, value: string): Promise<void> {
  await tmux(["set-option", "-p", "-t", paneId, key, value]);
}

async function readGlobalSidebarWidth(): Promise<number | undefined> {
  const result = await tmux(["show-option", "-gv", SIDEBAR_WIDTH_OPTION]);
  if (!result.ok) return undefined;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && result.stdout.trim() !== "" ? clampSidebarWidth(value) : undefined;
}

async function setGlobalSidebarWidth(width: number | undefined): Promise<void> {
  if (width === undefined) {
    await tmux(["set-option", "-gu", SIDEBAR_WIDTH_OPTION]);
    return;
  }
  await tmux(["set-option", "-g", SIDEBAR_WIDTH_OPTION, String(clampSidebarWidth(width))]);
}

/** The active tab is global config so every sidebar shares it and it persists. */
export async function readSidebarTab(): Promise<SidebarTab | undefined> {
  if (!process.env.TMUX) return undefined;
  const result = await tmux(["show-option", "-gv", SIDEBAR_TAB_OPTION]);
  if (!result.ok) return undefined;
  const value = result.stdout.trim();
  return isSidebarTab(value) ? value : undefined;
}

export async function writeSidebarTab(tab: SidebarTab): Promise<void> {
  if (!process.env.TMUX) return;
  await tmux(["set-option", "-g", SIDEBAR_TAB_OPTION, tab]);
}

/**
 * Resolve the command a sidebar pane runs. Env override wins for tests/dev.
 *
 * tmux spawns the pane through `/bin/sh -c` using the tmux *server's* PATH, which
 * frequently lacks the npm/pnpm global bin dir (or any node shim). A bare `pol`
 * there is "command not found" → the pane dies with exit 127. So we always emit
 * an absolute `node <script>` invocation: `process.execPath` is the absolute node
 * binary, and the script is resolved to an absolute path. When `pol` is installed
 * its bin is a symlink — `process.argv[1]` is that symlink's (absolute) path, and
 * node happily follows it to the real `cli.js`.
 */
export function sidebarCommand(): string {
  if (process.env.POL_SIDEBAR_COMMAND) return process.env.POL_SIDEBAR_COMMAND;
  return formatShellCommand([process.execPath, cliEntryPath(), "sidebar", "--sidebar"]);
}

/** Absolute path to the CLI entry, robust to relative argv and symlinked bins. */
function cliEntryPath(): string {
  const argv0 = process.argv[1];
  if (argv0) return isAbsolute(argv0) ? argv0 : resolve(process.cwd(), argv0);
  // No entry script (e.g. `node -e`): fall back to this module's sibling cli.js.
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

async function killPaneBestEffort(paneId: string): Promise<void> {
  await tmux(["kill-pane", "-t", paneId]);
}

async function openNavPane(windowTarget: string, width: number, command = sidebarCommand()): Promise<string | undefined> {
  const result = await tmux(
    // -f makes this a full-window split, not a split of whichever pane happened
    // to be active. No `-b` => the strip materializes on the RIGHT edge.
    ["split-window", "-h", "-f", "-d", "-l", String(width), "-P", "-F", "#{pane_id}", "-t", exactWindowTarget(windowTarget), command],
  );
  const paneId = result.ok ? result.stdout.trim() : "";
  if (!paneId) return undefined;
  await setPaneOption(paneId, SIDEBAR_NAV_PANE_OPTION, "1");
  return paneId;
}

async function removeOtherNavPanes(keepPaneId: string | undefined): Promise<void> {
  for (const paneId of await listAllNavPanes()) {
    if (keepPaneId && paneId === keepPaneId) continue;
    await killPaneBestEffort(paneId);
  }
}

export async function toggleSidebar(requestedWidth?: number): Promise<"opened" | "closed"> {
  if (!process.env.TMUX) throw new Error("pol sidebar --toggle-sidebar must run inside tmux");
  const windowTarget = await currentWindowTarget();
  const panes = await listWindowPanes(windowTarget);
  const nav = panes.find((pane) => pane.nav);
  if (nav) {
    await removeOtherNavPanes(undefined);
    await setGlobalSidebarWidth(undefined);
    return "closed";
  }
  const width = clampSidebarWidth(requestedWidth ?? (await readGlobalSidebarWidth()));
  const paneId = await openNavPane(windowTarget, width);
  if (!paneId) throw new Error("Failed to open pollinate sidebar pane");
  await setGlobalSidebarWidth(width);
  await removeOtherNavPanes(paneId);
  await tmux(["select-pane", "-t", paneId]);
  return "opened";
}

/** @internal test helper — builds the split argv without invoking tmux. */
export function __testOnlySplitArgs(windowTarget: string, width: number, command: string): string[] {
  return ["split-window", "-h", "-f", "-d", "-l", String(width), "-P", "-F", "#{pane_id}", "-t", exactWindowTarget(windowTarget), command];
}
