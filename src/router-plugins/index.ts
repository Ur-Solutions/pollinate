import { githubPrRouterPlugin, type RouterPlugin, type RouterPluginInput } from "./github-pr.js";

export { githubPrRouterPlugin };

const ROUTERS = new Map<string, RouterPlugin>([
  [githubPrRouterPlugin.name, githubPrRouterPlugin],
]);

export function getRouterPlugin(name: string): RouterPlugin {
  const plugin = ROUTERS.get(name);
  if (!plugin) throw new Error(`Unknown router plugin: ${name}`);
  return plugin;
}

export function listRouterPlugins(): string[] {
  return [...ROUTERS.keys()].sort();
}

export type { RouterPlugin, RouterPluginInput };
