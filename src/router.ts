import { renderAction } from "./templates.js";
import type { ActionResult } from "./actions.js";
import { getRouterPlugin } from "./router-plugins/index.js";
import type { Activation, Action, CanonicalRouterEvent, JsonValue, RouterBinding, RouterConfig, Trigger } from "./types.js";
import type { PollinateStore } from "./store.js";
import { nowIso } from "./time.js";

export type RouterActionExecutor = {
  executeAction(action: Action, cwd?: string): Promise<ActionResult>;
};

export type ExecuteRouterOptions = {
  store: PollinateStore;
  executor: RouterActionExecutor;
  trigger: Trigger;
  activation: Activation;
  cwd?: string;
};

export type RouterEventResult =
  | { subjectKey: string; kind: string; outcome: "created"; target: string }
  | { subjectKey: string; kind: string; outcome: "routed"; target: string }
  | { subjectKey: string; kind: string; outcome: "closed"; target: string }
  | { subjectKey: string; kind: string; outcome: "already-bound"; target?: string }
  | { subjectKey: string; kind: string; outcome: "dropped"; reason: string };

export async function executeRouter(options: ExecuteRouterOptions): Promise<{ plugin: string; events: RouterEventResult[] }> {
  const router = options.trigger.router;
  if (!router) throw new Error(`Trigger ${options.trigger.id} has no router`);
  const plugin = getRouterPlugin(router.plugin);
  const input = routerInput(options.activation);
  const events = plugin.normalize(input);
  const results: RouterEventResult[] = [];
  for (const event of events) {
    results.push(await handleRouterEvent(options, router, event));
  }
  return { plugin: plugin.name, events: results };
}

function routerInput(activation: Activation): { headers: Record<string, string>; body: JsonValue; path?: string } {
  const headers = activation.metadata?.webhook?.headers ?? {};
  const path = activation.metadata?.webhook?.path;
  return { headers, body: activation.payload, path };
}

async function handleRouterEvent(
  options: ExecuteRouterOptions,
  router: RouterConfig,
  event: CanonicalRouterEvent,
): Promise<RouterEventResult> {
  return options.store.withRouterBindingLock(options.trigger.id, event.subjectKey, async () => {
    const current = await options.store.getRouterBinding(options.trigger.id, event.subjectKey);
    if (router.openOn.includes(event.kind)) {
      if (current?.target) {
        await options.store.appendLedger({
          event: "pollinate.router.already_bound",
          trigger_id: options.trigger.id,
          router: router.plugin,
          subject_key: event.subjectKey,
          event_kind: event.kind,
          target: current.target.handle,
        });
        return { subjectKey: event.subjectKey, kind: event.kind, outcome: "already-bound", target: current.target.handle };
      }
      return createBinding(options, router, event, current);
    }

    if (!current?.target) {
      await options.store.appendLedger({
        event: "pollinate.router.unbound",
        trigger_id: options.trigger.id,
        router: router.plugin,
        subject_key: event.subjectKey,
        event_kind: event.kind,
      });
      return { subjectKey: event.subjectKey, kind: event.kind, outcome: "dropped", reason: "no binding" };
    }

    if (router.closeOn.includes(event.kind)) return closeBinding(options, router, event, current);
    return routeToBinding(options, router, event, current);
  });
}

async function createBinding(
  options: ExecuteRouterOptions,
  router: RouterConfig,
  event: CanonicalRouterEvent,
  existing: RouterBinding | null,
): Promise<RouterEventResult> {
  const now = nowIso();
  const pending: RouterBinding = existing ?? {
    id: bindingId(options.trigger.id, event.subjectKey),
    triggerId: options.trigger.id,
    router: router.plugin,
    subjectKey: event.subjectKey,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await options.store.saveRouterBinding({ ...pending, status: "pending", updatedAt: now, lastEventKind: event.kind });
  await options.store.appendLedger({
    event: "pollinate.router.binding_pending",
    trigger_id: options.trigger.id,
    router: router.plugin,
    subject_key: event.subjectKey,
    event_kind: event.kind,
  });

  try {
    const rendered = renderRouterAction(router.onOpen, event, pending);
    const result = await options.executor.executeAction(rendered, options.cwd);
    const handle = typeof result.handle === "string" ? result.handle : honeybeeSpawnName(rendered);
    if (!handle) throw new Error("Router onOpen action did not produce a target handle");
    const active: RouterBinding = {
      ...pending,
      status: "active",
      target: { kind: "hive", handle },
      updatedAt: nowIso(),
      lastActivityAt: nowIso(),
      lastEventKind: event.kind,
      error: undefined,
    };
    await options.store.saveRouterBinding(active);
    await options.store.appendLedger({
      event: "pollinate.router.binding_created",
      trigger_id: options.trigger.id,
      router: router.plugin,
      subject_key: event.subjectKey,
      event_kind: event.kind,
      target: handle,
    });
    return { subjectKey: event.subjectKey, kind: event.kind, outcome: "created", target: handle };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.store.saveRouterBinding({
      ...pending,
      status: "errored",
      updatedAt: nowIso(),
      lastEventKind: event.kind,
      error: message,
    });
    await options.store.appendLedger({
      event: "pollinate.router.binding_errored",
      trigger_id: options.trigger.id,
      router: router.plugin,
      subject_key: event.subjectKey,
      event_kind: event.kind,
      error: message,
    });
    throw error;
  }
}

async function routeToBinding(
  options: ExecuteRouterOptions,
  router: RouterConfig,
  event: CanonicalRouterEvent,
  binding: RouterBinding,
): Promise<RouterEventResult> {
  const action = renderRouterAction(router.onActivity, event, binding);
  await options.executor.executeAction(action, options.cwd);
  const updated = { ...binding, status: "active" as const, updatedAt: nowIso(), lastActivityAt: nowIso(), lastEventKind: event.kind };
  await options.store.saveRouterBinding(updated);
  await options.store.appendLedger({
    event: "pollinate.router.binding_routed",
    trigger_id: options.trigger.id,
    router: router.plugin,
    subject_key: event.subjectKey,
    event_kind: event.kind,
    target: binding.target?.handle,
  });
  return { subjectKey: event.subjectKey, kind: event.kind, outcome: "routed", target: binding.target!.handle };
}

async function closeBinding(
  options: ExecuteRouterOptions,
  router: RouterConfig,
  event: CanonicalRouterEvent,
  binding: RouterBinding,
): Promise<RouterEventResult> {
  const closing = { ...binding, status: "closing" as const, updatedAt: nowIso(), lastEventKind: event.kind };
  await options.store.saveRouterBinding(closing);
  const action = renderRouterAction(router.onClose ?? defaultCloseAction(), event, closing);
  await options.executor.executeAction(action, options.cwd);
  const closed = { ...closing, status: "closed" as const, updatedAt: nowIso(), lastActivityAt: nowIso() };
  await options.store.saveRouterBinding(closed);
  await options.store.appendLedger({
    event: "pollinate.router.binding_closed",
    trigger_id: options.trigger.id,
    router: router.plugin,
    subject_key: event.subjectKey,
    event_kind: event.kind,
    target: binding.target?.handle,
  });
  return { subjectKey: event.subjectKey, kind: event.kind, outcome: "closed", target: binding.target!.handle };
}

function renderRouterAction(action: Action, event: CanonicalRouterEvent, binding: RouterBinding): Action {
  const context: Record<string, unknown> = {
    ...event.payload,
    event_kind: event.kind,
    subject_key: event.subjectKey,
    binding_id: binding.id,
    target: binding.target?.handle ?? "",
    "binding.target": binding.target?.handle ?? "",
  };
  return renderAction(action, context).value;
}

function defaultCloseAction(): Action {
  return { kind: "honeybee", run: "kill", target: "{{binding.target}}" };
}

function honeybeeSpawnName(action: Action): string | undefined {
  return action.kind === "honeybee" && action.run === "spawn" ? action.name : undefined;
}

function bindingId(triggerId: string, subjectKey: string): string {
  return `${safePart(triggerId)}.${safePart(subjectKey)}`;
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "binding";
}
