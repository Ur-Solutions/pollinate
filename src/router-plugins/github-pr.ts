import { execArgv } from "../process.js";
import type { CanonicalRouterEvent, ExecutionProfile, JsonObject, JsonValue } from "../types.js";

export type RouterPluginInput = {
  headers: Record<string, string>;
  body: JsonValue;
  path?: string;
};

export type RouterSubjectState = "open" | "closed" | "unknown";

export type RouterSubjectStateOptions = {
  cwd?: string;
  timeoutMs?: number;
  execution?: ExecutionProfile;
};

export type RouterPlugin = {
  name: string;
  normalize(input: RouterPluginInput): CanonicalRouterEvent[] | Promise<CanonicalRouterEvent[]>;
  /** Optional: report whether the subject behind a binding is still open, for GC reconciliation. */
  subjectState?(subjectKey: string, options?: RouterSubjectStateOptions): RouterSubjectState | Promise<RouterSubjectState>;
};

type AnyRecord = Record<string, unknown>;

const SUBJECT_KEY_RE = /^github:pull_request:([^#\s]+)#(\d+)$/;

export const githubPrRouterPlugin: RouterPlugin = {
  name: "github-pr",
  normalize(input) {
    const event = input.headers["x-github-event"];
    const body = asRecord(input.body);
    if (!event || !body) return [];

    if (event === "pull_request") return normalizePullRequest(body);
    if (event === "issue_comment") return normalizeIssueComment(body);
    if (event === "pull_request_review") return normalizePullRequestReview(body);
    if (event === "pull_request_review_comment") return normalizePullRequestReviewComment(body);
    if (event === "check_run") return normalizeCheck(body, "check_run");
    if (event === "check_suite") return normalizeCheck(body, "check_suite");
    return [];
  },
  async subjectState(subjectKey, options = {}) {
    const match = SUBJECT_KEY_RE.exec(subjectKey);
    if (!match) return "unknown";
    const [, repo, number] = match;
    try {
      const result = await execArgv("gh", ["pr", "view", number!, "--repo", repo!, "--json", "state"], {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? 30_000,
        execution: options.execution,
      });
      if (result.exitCode !== 0) return "unknown";
      const state = String((JSON.parse(result.stdout) as { state?: unknown }).state ?? "").toUpperCase();
      if (state === "OPEN") return "open";
      if (state === "CLOSED" || state === "MERGED") return "closed";
      return "unknown";
    } catch {
      return "unknown";
    }
  },
};

function normalizePullRequest(body: AnyRecord): CanonicalRouterEvent[] {
  const action = stringValue(body.action, "unknown");
  const repo = repoFullName(body.repository);
  const pr = asRecord(body.pull_request);
  if (!repo || !pr) return [];
  const merged = Boolean(pr.merged);
  const eventKind = action === "closed" && merged ? "github.pull_request.merged" : `github.pull_request.${action}`;
  return [eventForPr(body, repo, pr, eventKind, { merged })];
}

function normalizeIssueComment(body: AnyRecord): CanonicalRouterEvent[] {
  const issue = asRecord(body.issue);
  if (!issue || !asRecord(issue.pull_request)) return [];
  const repo = repoFullName(body.repository);
  if (!repo) return [];
  const number = numberValue(issue.number);
  if (number === undefined) return [];
  const action = stringValue(body.action, "unknown");
  const comment = asRecord(body.comment);
  if (markedPollinateRouterComment(stringValue(comment?.body))) return [];
  return [
    eventForNumber(body, repo, number, `github.issue_comment.${action}`, clean({
      pr_url: stringValue(asRecord(issue.pull_request)?.html_url),
      pr_title: stringValue(issue.title),
      pr_author: stringValue(asRecord(issue.user)?.login),
      activity_url: stringValue(comment?.html_url),
      comment_body: stringValue(comment?.body),
    })),
  ];
}

function normalizePullRequestReview(body: AnyRecord): CanonicalRouterEvent[] {
  const repo = repoFullName(body.repository);
  const pr = asRecord(body.pull_request);
  if (!repo || !pr) return [];
  const action = stringValue(body.action, "unknown");
  const review = asRecord(body.review);
  if (markedPollinateRouterComment(stringValue(review?.body))) return [];
  return [
    eventForPr(body, repo, pr, `github.pull_request_review.${action}`, clean({
      activity_url: stringValue(review?.html_url),
      review_body: stringValue(review?.body),
      review_state: stringValue(review?.state),
    })),
  ];
}

function normalizePullRequestReviewComment(body: AnyRecord): CanonicalRouterEvent[] {
  const repo = repoFullName(body.repository);
  const pr = asRecord(body.pull_request);
  if (!repo || !pr) return [];
  const action = stringValue(body.action, "unknown");
  const comment = asRecord(body.comment);
  if (markedPollinateRouterComment(stringValue(comment?.body))) return [];
  return [
    eventForPr(body, repo, pr, `github.pull_request_review_comment.${action}`, clean({
      activity_url: stringValue(comment?.html_url),
      comment_body: stringValue(comment?.body),
      file_path: stringValue(comment?.path),
      line: jsonNumber(comment?.line),
    })),
  ];
}

function normalizeCheck(body: AnyRecord, event: "check_run" | "check_suite"): CanonicalRouterEvent[] {
  const repo = repoFullName(body.repository);
  if (!repo) return [];
  const check = asRecord(body[event]);
  const prs = Array.isArray(check?.pull_requests) ? check.pull_requests : [];
  const first = asRecord(prs[0]);
  const number = numberValue(first?.number);
  if (number === undefined) return [];
  const action = stringValue(body.action, "unknown");
  return [
    eventForNumber(body, repo, number, `github.${event}.${action}`, clean({
      activity_url: stringValue(check?.html_url),
      check_name: stringValue(check?.name),
      check_status: stringValue(check?.status),
      check_conclusion: stringValue(check?.conclusion),
    })),
  ];
}

function eventForPr(body: AnyRecord, repo: string, pr: AnyRecord, kind: string, extra: JsonObject = {}): CanonicalRouterEvent {
  const number = numberValue(pr.number) ?? 0;
  return eventForNumber(body, repo, number, kind, clean({
    pr_url: stringValue(pr.html_url),
    pr_title: stringValue(pr.title),
    pr_state: stringValue(pr.state),
    pr_author: stringValue(asRecord(pr.user)?.login),
    ...extra,
  }));
}

function eventForNumber(body: AnyRecord, repo: string, prNumber: number, kind: string, extra: JsonObject = {}): CanonicalRouterEvent {
  const [repoOwner = "", repoName = ""] = repo.split("/", 2);
  const actor = stringValue(asRecord(body.sender)?.login);
  const payload: JsonObject = {
    provider: "github",
    subject_kind: "pull_request",
    repo,
    repo_owner: repoOwner,
    repo_name: repoName,
    repo_slug: slug(`${repoOwner}-${repoName}`),
    pr_number: String(prNumber),
    event_kind: kind,
    action: stringValue(body.action) ?? "unknown",
    actor: actor ?? "",
    activity_markdown: activityMarkdown({ repo, prNumber, kind, actor, extra }),
    ...extra,
  };
  return {
    subjectKey: `github:pull_request:${repo}#${prNumber}`,
    kind,
    payload,
  };
}

function clean(values: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined));
}

function activityMarkdown(input: { repo: string; prNumber: number; kind: string; actor?: string; extra: JsonObject }): string {
  const lines = [`${input.kind} on ${input.repo}#${input.prNumber}`];
  if (input.actor) lines.push(`Actor: ${input.actor}`);
  const body = stringValue(input.extra.comment_body) ?? stringValue(input.extra.review_body);
  if (body) lines.push("", body);
  const url = stringValue(input.extra.activity_url) ?? stringValue(input.extra.pr_url);
  if (url) lines.push("", url);
  return lines.join("\n");
}

function markedPollinateRouterComment(body: string | undefined): boolean {
  return body?.includes("<!-- pollinate-router -->") ?? false;
}

function repoFullName(value: unknown): string | undefined {
  return stringValue(asRecord(value)?.full_name);
}

function asRecord(value: unknown): AnyRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as AnyRecord;
}

function stringValue(value: unknown, fallback?: string): string | undefined {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value : String(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function jsonNumber(value: unknown): JsonValue {
  const number = numberValue(value);
  return number === undefined ? null : number;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}
