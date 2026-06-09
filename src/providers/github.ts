import type { ExecutionProfile } from "../types.js";
import { execShell, shellQuote } from "../process.js";

export const GITHUB_PR_ROUTER_EVENTS = [
  "pull_request",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
  "check_suite",
];

export type GithubWebhookInstallOptions = {
  repo: string;
  url: string;
  secret?: string;
  events?: string[];
  active?: boolean;
  dryRun?: boolean;
  cwd?: string;
  timeoutMs?: number;
  execution?: ExecutionProfile;
};

export type GithubWebhookInstallResult = {
  provider: "github";
  repo: string;
  url: string;
  events: string[];
  action: "created" | "updated" | "dry-run";
  hookId?: number;
  secretConfigured: boolean;
  request: GithubHookRequest;
};

type GithubHookRequest = {
  name: "web";
  active: boolean;
  events: string[];
  config: {
    url: string;
    content_type: "json";
    insecure_ssl: "0";
    secret?: string;
  };
};

type GithubHook = {
  id?: number;
  name?: string;
  config?: {
    url?: string;
  };
};

export async function installGithubWebhook(options: GithubWebhookInstallOptions): Promise<GithubWebhookInstallResult> {
  const events = options.events?.length ? options.events : GITHUB_PR_ROUTER_EVENTS;
  const request: GithubHookRequest = {
    name: "web",
    active: options.active ?? true,
    events,
    config: {
      url: options.url,
      content_type: "json",
      insecure_ssl: "0",
      ...(options.secret ? { secret: options.secret } : {}),
    },
  };
  if (options.dryRun) {
    return {
      provider: "github",
      repo: options.repo,
      url: options.url,
      events,
      action: "dry-run",
      secretConfigured: Boolean(options.secret),
      request: redactHookRequest(request),
    };
  }

  const existing = await findGithubWebhook(options);
  const endpoint = existing?.id === undefined ? `repos/${options.repo}/hooks` : `repos/${options.repo}/hooks/${existing.id}`;
  const method = existing?.id === undefined ? "POST" : "PATCH";
  const result = await ghApi(endpoint, { ...options, method, input: JSON.stringify(request) });
  if (result.exitCode !== 0) throw new Error(`gh api ${method} ${endpoint} exited ${result.exitCode}: ${result.stderr.trim()}`);
  const hook = parseHook(result.stdout);
  return {
    provider: "github",
    repo: options.repo,
    url: options.url,
    events,
    action: existing?.id === undefined ? "created" : "updated",
    hookId: hook.id ?? existing?.id,
    secretConfigured: Boolean(options.secret),
    request: redactHookRequest(request),
  };
}

async function findGithubWebhook(options: GithubWebhookInstallOptions): Promise<GithubHook | null> {
  const result = await ghApi(`repos/${options.repo}/hooks`, { ...options, method: "GET" });
  if (result.exitCode !== 0) throw new Error(`gh api GET repos/${options.repo}/hooks exited ${result.exitCode}: ${result.stderr.trim()}`);
  const parsed = JSON.parse(result.stdout || "[]") as unknown;
  if (!Array.isArray(parsed)) return null;
  return (parsed as GithubHook[]).find((hook) => hook.name === "web" && hook.config?.url === options.url) ?? null;
}

function ghApi(endpoint: string, options: GithubWebhookInstallOptions & { method: string; input?: string }) {
  const input = options.input ? " --input -" : "";
  return execShell(`gh api --method ${shellQuote(options.method)} ${shellQuote(endpoint)}${input}`, {
    cwd: options.cwd,
    input: options.input,
    timeoutMs: options.timeoutMs,
    execution: options.execution,
  });
}

function parseHook(stdout: string): GithubHook {
  try {
    const parsed = JSON.parse(stdout || "{}") as GithubHook;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function redactHookRequest(request: GithubHookRequest): GithubHookRequest {
  return {
    ...request,
    config: {
      ...request.config,
      ...(request.config.secret ? { secret: "<redacted>" } : {}),
    },
  };
}
