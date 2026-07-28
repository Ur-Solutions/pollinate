import { resolve } from "node:path";
import { execArgv, type ExecOptions, type ExecResult } from "./process.js";
import type {
  CombCliErrorCode,
  CombRunAction,
  CombRunJobFailure,
  CombRunJobSuccess,
  JsonValue,
} from "./types.js";

const COMB_COMMAND = "comb.run";
const RUN_ID_RE = /^[0-9A-Za-z-]+$/;
const CLAIM_ID_RE = /^[0-9a-f]{64}$/;
const ERROR_EXIT_CODES: Record<CombCliErrorCode, number> = {
  invalid_argument: 2,
  not_found: 3,
  version_conflict: 4,
  claim_conflict: 4,
  ambiguous_activation: 5,
  cancelled: 5,
  approval_required: 5,
  effect_ambiguous: 6,
  external_dependency: 7,
  corrupt_state: 70,
};

export type CombRunProvenance = {
  triggerId: string;
  deliveryId: string;
};

export type CombRunInvocation = {
  args: string[];
  cwd: string;
  input: string;
};

type CombCliFailureEnvelope = {
  ok: false;
  command: "comb.run";
  error: {
    code: CombCliErrorCode;
    message: string;
    details?: JsonValue;
  };
};

export class CombActionError extends Error {
  readonly result: CombRunJobFailure;

  constructor(result: CombRunJobFailure) {
    const holder = result.holdingRunId ? ` (held by ${result.holdingRunId})` : "";
    super(`hive comb run ${result.error.code}: ${result.error.message}${holder}`);
    this.name = "CombActionError";
    this.result = result;
  }
}

export function buildCombRunInvocation(
  action: CombRunAction,
  cwd: string | undefined,
  provenance: CombRunProvenance,
): CombRunInvocation {
  const resolvedCwd = resolve(cwd ?? process.cwd());
  return {
    args: [
      "comb",
      "run",
      action.comb,
      "--version",
      String(action.version),
      "--input",
      "-",
      "--cwd",
      resolvedCwd,
      "--product",
      action.product,
      "--origin-trigger",
      provenance.triggerId,
      "--origin-delivery",
      provenance.deliveryId,
      ...(action.collision ? ["--collision", action.collision] : []),
      "--json",
    ],
    cwd: resolvedCwd,
    input: `${JSON.stringify(action.input)}\n`,
  };
}

export async function executeCombRun(
  action: CombRunAction,
  cwd: string | undefined,
  provenance: CombRunProvenance,
  options: { timeoutMs: number; execution?: ExecOptions["execution"] },
): Promise<CombRunJobSuccess> {
  const invocation = buildCombRunInvocation(action, cwd, provenance);
  let processResult: ExecResult;
  try {
    processResult = await execArgv("hive", invocation.args, {
      cwd: invocation.cwd,
      input: invocation.input,
      timeoutMs: options.timeoutMs,
      execution: options.execution,
    });
  } catch (error) {
    throw new CombActionError(
      failureResult(action, provenance.deliveryId, {
        code: "transport_failure",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        exitCode: null,
      }),
    );
  }
  return parseCombRunResult(action, provenance.deliveryId, processResult);
}

export function parseCombRunResult(
  action: Pick<CombRunAction, "comb" | "version">,
  deliveryId: string,
  processResult: ExecResult,
): CombRunJobSuccess {
  if (processResult.timedOut) {
    throw new CombActionError(
      failureResult(action, deliveryId, {
        code: "transport_failure",
        message: "hive comb run timed out",
        retryable: true,
        exitCode: processResult.exitCode,
      }),
    );
  }
  if (processResult.exitCode === null) {
    throw new CombActionError(
      failureResult(action, deliveryId, {
        code: "transport_failure",
        message: processResult.signal
          ? `hive comb run terminated by ${processResult.signal}`
          : "hive comb run terminated without an exit code",
        retryable: true,
        exitCode: null,
      }),
    );
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = parseSingleEnvelope(processResult.stdout);
  } catch (error) {
    throw new CombActionError(
      failureResult(action, deliveryId, {
        code: "invalid_envelope",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        exitCode: processResult.exitCode,
      }),
    );
  }

  if (envelope.command !== COMB_COMMAND) {
    throw invalidEnvelope(action, deliveryId, processResult.exitCode, `expected command ${COMB_COMMAND}, received ${JSON.stringify(envelope.command)}`);
  }

  if (processResult.exitCode === 0) {
    if (envelope.ok !== true) {
      throw invalidEnvelope(action, deliveryId, processResult.exitCode, "exit 0 did not contain an ok:true envelope");
    }
    try {
      return successResult(action, deliveryId, envelope);
    } catch (error) {
      throw invalidEnvelope(
        action,
        deliveryId,
        processResult.exitCode,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (envelope.ok !== false) {
    throw invalidEnvelope(action, deliveryId, processResult.exitCode, `exit ${String(processResult.exitCode)} did not contain an ok:false envelope`);
  }
  let failure: CombCliFailureEnvelope;
  try {
    failure = canonicalFailure(envelope);
  } catch (error) {
    throw invalidEnvelope(
      action,
      deliveryId,
      processResult.exitCode,
      error instanceof Error ? error.message : String(error),
    );
  }
  const expectedExit = ERROR_EXIT_CODES[failure.error.code];
  if (processResult.exitCode !== expectedExit) {
    throw invalidEnvelope(
      action,
      deliveryId,
      processResult.exitCode,
      `${failure.error.code} requires exit ${expectedExit}, received ${String(processResult.exitCode)}`,
    );
  }
  const details = failure.error.details;
  let holdingRunId: string | undefined;
  if (failure.error.code === "claim_conflict") {
    try {
      const claim = canonicalClaimConflictDetails(details);
      holdingRunId = claim.holdingRunId;
    } catch (error) {
      throw invalidEnvelope(
        action,
        deliveryId,
        processResult.exitCode,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  throw new CombActionError({
    deliveryId,
    comb: action.comb,
    version: action.version,
    retryable: processResult.exitCode === 7,
    exitCode: processResult.exitCode,
    error: failure.error,
    ...(holdingRunId ? { holdingRunId } : {}),
  });
}

function successResult(
  action: Pick<CombRunAction, "comb" | "version">,
  deliveryId: string,
  envelope: Record<string, unknown>,
): CombRunJobSuccess {
  const result = objectAt(envelope.result, "result");
  const run = objectAt(result.run, "result.run");
  const runId = stringAt(run.id, "result.run.id");
  if (!RUN_ID_RE.test(runId)) throw new Error(`result.run.id is not a valid Comb run ID: ${JSON.stringify(runId)}`);
  const success = {
    deliveryId,
    runId,
    comb: action.comb,
    version: action.version,
    created: booleanAt(result.created, "result.created"),
    joinedExisting: booleanAt(result.joinedExisting, "result.joinedExisting"),
    replayedDelivery: booleanAt(result.replayedDelivery, "result.replayedDelivery"),
    intakeReady: booleanAt(result.intakeReady, "result.intakeReady"),
  };
  if (success.created === success.joinedExisting) {
    throw new Error("result must set exactly one of created or joinedExisting");
  }
  return success;
}

function canonicalFailure(envelope: Record<string, unknown>): CombCliFailureEnvelope {
  const error = objectAt(envelope.error, "error");
  const code = stringAt(error.code, "error.code") as CombCliErrorCode;
  if (!Object.hasOwn(ERROR_EXIT_CODES, code)) {
    throw new Error(`unsupported Comb error code: ${JSON.stringify(code)}`);
  }
  const details = error.details;
  if (details !== undefined && !isJsonValue(details)) throw new Error("error.details is not JSON");
  return {
    ok: false,
    command: COMB_COMMAND,
    error: {
      code,
      message: stringAt(error.message, "error.message"),
      ...(details !== undefined ? { details } : {}),
    },
  };
}

function canonicalClaimConflictDetails(details: JsonValue | undefined): {
  claimId: string;
  holdingRunId: string;
  holdingRunStatus: string;
  cleanupStatus: string;
} {
  const value = objectAt(details, "error.details");
  const expected = ["claimId", "cleanupStatus", "holdingRunId", "holdingRunStatus"];
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`claim_conflict details must contain exactly ${expected.join(", ")}`);
  }
  const holdingRunId = stringAt(value.holdingRunId, "error.details.holdingRunId");
  if (!RUN_ID_RE.test(holdingRunId)) {
    throw new Error(`error.details.holdingRunId is not a valid Comb run ID: ${JSON.stringify(holdingRunId)}`);
  }
  const claimId = stringAt(value.claimId, "error.details.claimId");
  if (!CLAIM_ID_RE.test(claimId)) {
    throw new Error(`error.details.claimId is not a valid claim ID: ${JSON.stringify(claimId)}`);
  }
  return {
    claimId,
    holdingRunId,
    holdingRunStatus: stringAt(value.holdingRunStatus, "error.details.holdingRunStatus"),
    cleanupStatus: stringAt(value.cleanupStatus, "error.details.cleanupStatus"),
  };
}

function parseSingleEnvelope(stdout: string): Record<string, unknown> {
  if (!stdout.endsWith("\n")) throw new Error("Comb stdout must end with one trailing newline");
  const body = stdout.slice(0, -1);
  if (!body || body.trim() !== body) throw new Error("Comb stdout must contain only one JSON envelope");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`Comb stdout is not one JSON envelope: ${error instanceof Error ? error.message : String(error)}`);
  }
  return objectAt(parsed, "envelope");
}

function invalidEnvelope(
  action: Pick<CombRunAction, "comb" | "version">,
  deliveryId: string,
  exitCode: number | null,
  message: string,
): CombActionError {
  return new CombActionError(
    failureResult(action, deliveryId, {
      code: "invalid_envelope",
      message,
      retryable: false,
      exitCode,
    }),
  );
}

function failureResult(
  action: Pick<CombRunAction, "comb" | "version">,
  deliveryId: string,
  failure: {
    code: "transport_failure" | "invalid_envelope";
    message: string;
    retryable: boolean;
    exitCode: number | null;
  },
): CombRunJobFailure {
  return {
    deliveryId,
    comb: action.comb,
    version: action.version,
    retryable: failure.retryable,
    exitCode: failure.exitCode,
    error: {
      code: failure.code,
      message: failure.message,
    },
  };
}

function objectAt(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function booleanAt(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}
