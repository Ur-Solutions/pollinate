export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SourceKind = "schedule" | "poll" | "webhook" | "manual";

export type ScheduleTiming =
  | { type: "cron"; expression: string; timezone?: string; missedFirePolicy?: MissedFirePolicy }
  | { type: "every"; interval: string; missedFirePolicy?: MissedFirePolicy }
  | { type: "once"; at: string; missedFirePolicy?: MissedFirePolicy };

export type MissedFirePolicy = "skip" | "fire-once" | "fire-all";

export type PollFetch =
  | { kind: "command"; command: string; cwd?: string }
  | { kind: "http"; method?: string; url: string; headers?: Record<string, string> }
  | { kind: "file"; path: string };

export type PollCursor =
  | { strategy: "append-offset" }
  | { strategy: "hash" }
  | { strategy: "jsonpath"; jsonpath: string };

export type PollSpec = {
  interval: string;
  fetch: PollFetch;
  cursor: PollCursor;
  emit: "per-item" | "per-poll";
};

export type WebhookSpec = {
  path: string;
  secret?: string;
  transform?: Record<string, string>;
};

export type Source =
  | { kind: "schedule"; timing: ScheduleTiming }
  | { kind: "poll"; poll: PollSpec }
  | { kind: "webhook"; webhook: WebhookSpec }
  | { kind: "manual" };

export type Filter = Record<string, JsonValue>;

export type DeliveryMode =
  | { strategy: "immediate" }
  | { strategy: "throttled"; interval: string; collect: boolean }
  | { strategy: "batched"; window: string; maxBatch: number }
  | { strategy: "debounced"; quietPeriod: string };

export type Delivery = {
  mode: DeliveryMode;
  maxConcurrent: number;
};

export type BuzTier = "interrupt" | "queue" | "passive";

export type HoneybeeAction =
  | { kind: "honeybee"; run: "flow"; flow: string; args?: Record<string, string> }
  | { kind: "honeybee"; run: "loop"; loop: Record<string, JsonValue> }
  | {
      kind: "honeybee";
      run: "spawn";
      bee: string;
      name?: string;
      colony?: string;
      home?: string;
      cwd?: string;
      yolo?: boolean;
      acceptTrust?: boolean;
      args?: string[];
      message?: string;
      timeout?: string;
    }
  | { kind: "honeybee"; run: "send"; target: string; message: string; timeout?: string }
  | { kind: "honeybee"; run: "buz"; target: string; message: string; tier?: BuzTier; subject?: string; senderHuman?: string; timeout?: string }
  | { kind: "honeybee"; run: "kill"; target: string; timeout?: string };

export type ActionStep = {
  id?: string;
  action: Action;
};

export type Action =
  | HoneybeeAction
  | { kind: "sequence"; mode?: "serial" | "parallel"; primary?: string; continueOnError?: boolean; actions: ActionStep[] }
  | { kind: "command"; command: string; cwd?: string; timeout?: string }
  | { kind: "http"; method: string; url: string; headers?: Record<string, string>; body?: string; timeout?: string }
  | { kind: "hermes"; invoke: string; payload?: string; timeout?: string }
  | { kind: "emit"; subject: string; payload?: string };

export type ContextSource =
  | { var: string; kind: "command"; command: string; cwd?: string; timeout?: string }
  | { var: string; kind: "http"; url: string; jsonpath?: string; timeout?: string }
  | { var: string; kind: "file"; path: string; timeout?: string }
  | { var: string; kind: "honeybee"; query: string; timeout?: string };

export type ContextResolver = {
  sources?: ContextSource[];
  static?: Record<string, string>;
};

export type RouterConfig = {
  plugin: string;
  openOn: string[];
  closeOn: string[];
  openWhen?: Filter;
  idleTtl?: string;
  onOpen: Action;
  onActivity: Action;
  onClose?: Action;
};

export type TriggerLifecycle = {
  temporary?: boolean;
  expiresAt?: string;
  maxDeliveries?: number;
  deliveries?: number;
};

export type Trigger = {
  id: string;
  name: string;
  description?: string;
  cwd?: string;
  tags: string[];
  enabled: boolean;
  source: Source;
  filter?: Filter;
  delivery: Delivery;
  context?: ContextResolver;
  lifecycle?: TriggerLifecycle;
  router?: RouterConfig;
  action?: Action;
  createdAt: string;
  updatedAt: string;
};

export type JobStatus =
  | "queued"
  | "resolving-context"
  | "running"
  | "completed"
  | "errored"
  | "timed-out"
  | "cancelled";

export type Job = {
  id: string;
  idPrefix?: string;
  uuid?: string;
  triggerId: string;
  source: SourceKind;
  status: JobStatus;
  cwd?: string;
  context: Record<string, string>;
  action?: Action;
  result?: unknown;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  batch?: JsonValue[];
};

export type Activation = {
  triggerId: string;
  source: SourceKind;
  payload: JsonValue;
  receivedAt: string;
  metadata?: {
    webhook?: {
      path?: string;
      headers?: Record<string, string>;
    };
  };
};

export type CanonicalRouterEvent = {
  subjectKey: string;
  kind: string;
  payload: JsonObject;
};

export type RouterBindingStatus = "pending" | "active" | "closing" | "closed" | "errored";

export type RouterBindingTarget = {
  kind: "hive";
  handle: string;
  handles?: Record<string, string>;
};

export type RouterBinding = {
  id: string;
  triggerId: string;
  router: string;
  subjectKey: string;
  status: RouterBindingStatus;
  target?: RouterBindingTarget;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  lastEventKind?: string;
  error?: string;
  /** Payload of the event that opened (or last tried to open) the binding; lets the GC re-render onOpen/onClose. */
  context?: JsonObject;
  /** Failed onOpen attempts since the binding last went active; bounds GC retries. */
  openAttempts?: number;
  /** Last time the GC reconciled this binding against the live subject state. */
  checkedAt?: string;
};

export type ScheduleState = Record<
  string,
  {
    lastFireAt?: string;
    nextFireAt?: string;
    completedOnce?: boolean;
  }
>;

export type DeliveryState = Record<
  string,
  {
    throttleUntil?: string;
    pendingBatch?: Activation[];
    timerDueAt?: string;
    timerKind?: "throttled" | "batched" | "debounced";
    queue?: Array<{ job: Job; activation: Activation; batch: JsonValue[] }>;
  }
>;

export type CursorState = Record<string, JsonValue>;

export type ExecutionProfile = {
  shell: string;
  shellArgs: string[];
  inheritEnv: boolean;
  env: Record<string, string>;
};

export type WebhookRelayConfig = {
  secret?: string;
  maxAgeSeconds: number;
};

export type DaemonConfig = {
  webhook: {
    bind: string;
    port: number;
    publicUrl?: string;
    relay: WebhookRelayConfig;
  };
  defaults: {
    contextTimeout: string;
    commandTimeout: string;
    tickMs: number;
    triggerReloadMs: number;
    bindingGcMs: number;
  };
  execution: ExecutionProfile;
};

export type LedgerEvent = {
  event: string;
  ts?: string;
  [key: string]: unknown;
};

export type DryRunResult = {
  triggerId: string;
  cwd?: string;
  context: Record<string, string>;
  action?: Action;
  warnings: string[];
};
