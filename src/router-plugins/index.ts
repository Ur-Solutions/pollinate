import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { githubPrRouterPlugin, type RouterPlugin, type RouterPluginInput } from "./github-pr.js";
import { pathExists, routerPluginsDir, storeRoot } from "../fsx.js";

export { githubPrRouterPlugin };

const BUILTIN_ROUTERS = new Map<string, RouterPlugin>([
  [githubPrRouterPlugin.name, githubPrRouterPlugin],
]);

const MODULE_EXTENSIONS = [".mjs", ".js", ".cjs"];
const moduleCache = new Map<string, Promise<RouterPlugin>>();

export type RouterPluginLookupOptions = {
  root?: string;
  cwd?: string;
};

export async function getRouterPlugin(name: string, options: RouterPluginLookupOptions = {}): Promise<RouterPlugin> {
  const builtin = BUILTIN_ROUTERS.get(name);
  if (builtin) return builtin;
  const path = await resolveRouterPluginPath(name, options);
  if (!path) throw new Error(`Unknown router plugin: ${name}`);
  const info = await stat(path);
  const key = `${pathToFileURL(path).href}?mtime=${Math.trunc(info.mtimeMs)}`;
  let loaded = moduleCache.get(key);
  if (!loaded) {
    loaded = import(key).then((mod) => validateRouterPlugin(mod.routerPlugin ?? mod.plugin ?? mod.default ?? mod, name));
    moduleCache.set(key, loaded);
  }
  return loaded;
}

export async function listRouterPlugins(options: RouterPluginLookupOptions = {}): Promise<string[]> {
  const root = options.root ?? storeRoot();
  const local = await readdir(routerPluginsDir(root)).catch(() => []);
  return [...new Set([
    ...BUILTIN_ROUTERS.keys(),
    ...local.flatMap((entry) => {
      const ext = MODULE_EXTENSIONS.find((candidate) => entry.endsWith(candidate));
      return ext ? [entry.slice(0, -ext.length)] : [];
    }),
  ])].sort();
}

export function routerPluginTemplate(name: string): string {
  return `/** @type {import("pollinate").RouterPlugin} */
export default {
  name: ${JSON.stringify(name)},
  normalize(input) {
    const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? input.body : {};
    const kind = String(body.action ?? "received");
    return [{
      subjectKey: ${JSON.stringify(`${name}:subject`)},
      kind: ${JSON.stringify(`${name}.`)} + kind,
      payload: {
        event_kind: ${JSON.stringify(`${name}.`)} + kind,
        activity_markdown: ${JSON.stringify(`${name} event`)} + ": " + kind,
      },
    }];
  },
};
`;
}

async function resolveRouterPluginPath(name: string, options: RouterPluginLookupOptions): Promise<string | null> {
  if (looksLikePath(name)) {
    const resolved = isAbsolute(name) ? name : resolve(options.cwd ?? process.cwd(), name);
    return (await pathExists(resolved)) ? resolved : null;
  }
  const root = options.root ?? storeRoot();
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = join(routerPluginsDir(root), `${name}${ext}`);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.includes("\\");
}

function validateRouterPlugin(value: unknown, requestedName: string): RouterPlugin {
  if (!value || typeof value !== "object") throw new Error(`Router plugin ${requestedName} did not export a plugin object`);
  const plugin = value as Partial<RouterPlugin>;
  if (typeof plugin.name !== "string" || plugin.name.length === 0) throw new Error(`Router plugin ${requestedName} is missing a string name`);
  if (typeof plugin.normalize !== "function") throw new Error(`Router plugin ${requestedName} is missing normalize(input)`);
  return plugin as RouterPlugin;
}

export type { RouterPlugin, RouterPluginInput };
