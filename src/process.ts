import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExecutionProfile } from "./types.js";

export type ExecResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ExecOptions = { cwd?: string; timeoutMs?: number; input?: string; execution?: ExecutionProfile };

export function execShell(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const child = options.execution
    ? spawn(options.execution.shell, [...options.execution.shellArgs, command], {
        cwd: options.cwd,
        env: executionEnv(options.execution),
        stdio: ["pipe", "pipe", "pipe"],
      })
    : spawn(command, {
        cwd: options.cwd,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
  return collectChild(child, options);
}

/**
 * Executes a binary with an argv array and no shell, so argument values
 * (webhook payloads, comment bodies, templated strings) can never be
 * interpreted as shell syntax.
 */
export function execArgv(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.execution ? executionEnv(options.execution) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return collectChild(child, options);
}

function collectChild(child: ChildProcessWithoutNullStreams, options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 1_000).unref();
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function executionEnv(profile: ExecutionProfile): NodeJS.ProcessEnv {
  return {
    ...(profile.inheritEnv ? process.env : {}),
    ...profile.env,
  };
}
