import http from "node:http";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActionExecutor, DeliveryManager, resolveContext } from "../src/index.js";
import { installCommandStub, installHiveStub, trigger, waitForJobs, waitForTerminalJobs, withTempStore } from "./helpers.js";

describe("delivery manager", () => {
  test("filters block nonmatching activations and allow equality/existence matches", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "filtered", filter: { status: "done", agent: true, meta: { b: 2, a: 1 } } });
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([trig]);
      expect(
        await delivery.handle(trig, {
          triggerId: trig.id,
          source: "manual",
          payload: { status: "running", agent: "codex", meta: { a: 1, b: 2 } },
          receivedAt: new Date().toISOString(),
        }),
      ).toBeNull();
      expect(
        await delivery.handle(trig, {
          triggerId: trig.id,
          source: "manual",
          payload: { status: "done", meta: { a: 1, b: 2 } },
          receivedAt: new Date().toISOString(),
        }),
      ).toBeNull();
      const job = await delivery.handle(trig, {
        triggerId: trig.id,
        source: "manual",
        payload: { status: "done", agent: "codex", meta: { a: 1, b: 2 } },
        receivedAt: new Date().toISOString(),
      });
      expect(job).not.toBeNull();
      await waitForTerminalJobs(store, 1);
      await delivery.shutdown();
    });
  });

  test("immediate maps one activation to one job", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({ id: "immediate" });
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([trig]);
      const job = await delivery.handle(trig, { triggerId: trig.id, source: "manual", payload: { n: 1 }, receivedAt: new Date().toISOString() });
      expect(job).not.toBeNull();
      const [completed] = await waitForTerminalJobs(store, 1);
      expect(completed.status).toBe("completed");
      expect(completed.context.batch_count).toBe("1");
      await delivery.shutdown();
    });
  });

  test("init prunes delivery state for removed triggers", async () => {
    await withTempStore(async (store) => {
      await store.writeDeliveryState({ orphaned: { queue: [] } });
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([trigger({ id: "active" })]);
      expect(await store.readDeliveryState()).toEqual({});
      await delivery.shutdown();
    });
  });

  test("batched, debounced, and throttled collect payloads into batch vars", async () => {
    await withTempStore(async (store) => {
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const batched = trigger({
        id: "batched",
        delivery: { mode: { strategy: "batched", window: "40ms", maxBatch: 10 }, maxConcurrent: 1 },
      });
      const debounced = trigger({
        id: "debounced",
        delivery: { mode: { strategy: "debounced", quietPeriod: "40ms" }, maxConcurrent: 1 },
      });
      const throttled = trigger({
        id: "throttled",
        delivery: { mode: { strategy: "throttled", interval: "40ms", collect: true }, maxConcurrent: 1 },
      });
      const delivery = new DeliveryManager(store, executor);
      await delivery.init([batched, debounced, throttled]);

      await delivery.handle(batched, { triggerId: "batched", source: "manual", payload: "a", receivedAt: new Date().toISOString() });
      await delivery.handle(batched, { triggerId: "batched", source: "manual", payload: "b", receivedAt: new Date().toISOString() });

      await delivery.handle(debounced, { triggerId: "debounced", source: "manual", payload: "a", receivedAt: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await delivery.handle(debounced, { triggerId: "debounced", source: "manual", payload: "b", receivedAt: new Date().toISOString() });

      await delivery.handle(throttled, { triggerId: "throttled", source: "manual", payload: "first", receivedAt: new Date().toISOString() });
      await delivery.handle(throttled, { triggerId: "throttled", source: "manual", payload: "second", receivedAt: new Date().toISOString() });

      const jobs = await waitForTerminalJobs(store, 4);
      const byTrigger = new Map(jobs.map((job) => [job.triggerId, job]));
      expect(byTrigger.get("batched")?.context.batch_count).toBe("2");
      expect(byTrigger.get("debounced")?.context.batch_count).toBe("2");
      expect(jobs.filter((job) => job.triggerId === "throttled").map((job) => job.context.batch_count).sort()).toEqual(["1", "1"]);
      await delivery.shutdown();
    });
  });

  test("throttled non-collect drops cooldown activations and maxBatch flushes immediately", async () => {
    await withTempStore(async (store) => {
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const throttled = trigger({
        id: "drop",
        delivery: { mode: { strategy: "throttled", interval: "80ms", collect: false }, maxConcurrent: 1 },
      });
      const batch = trigger({
        id: "maxbatch",
        delivery: { mode: { strategy: "batched", window: "5s", maxBatch: 3 }, maxConcurrent: 1 },
      });
      const delivery = new DeliveryManager(store, executor);
      await delivery.init([throttled, batch]);
      await delivery.handle(throttled, { triggerId: "drop", source: "manual", payload: "a", receivedAt: new Date().toISOString() });
      await delivery.handle(throttled, { triggerId: "drop", source: "manual", payload: "b", receivedAt: new Date().toISOString() });
      await delivery.handle(batch, { triggerId: "maxbatch", source: "manual", payload: 1, receivedAt: new Date().toISOString() });
      await delivery.handle(batch, { triggerId: "maxbatch", source: "manual", payload: 2, receivedAt: new Date().toISOString() });
      await delivery.handle(batch, { triggerId: "maxbatch", source: "manual", payload: 3, receivedAt: new Date().toISOString() });

      const jobs = await waitForTerminalJobs(store, 2);
      expect(jobs.filter((job) => job.triggerId === "drop")).toHaveLength(1);
      expect(jobs.find((job) => job.triggerId === "maxbatch")?.context.batch_count).toBe("3");
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect((await store.listJobs()).filter((job) => job.triggerId === "drop")).toHaveLength(1);
      await delivery.shutdown();
    });
  });

  test("maxConcurrent queues and drains FIFO", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "fifo",
        delivery: { mode: { strategy: "immediate" }, maxConcurrent: 1 },
        action: { kind: "command", command: "node -e \"setTimeout(()=>{},120)\"", timeout: "1s" },
      });
      const delivery = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await delivery.init([trig]);
      for (const n of [1, 2, 3]) {
        await delivery.handle(trig, { triggerId: trig.id, source: "manual", payload: { n }, receivedAt: new Date().toISOString() });
      }
      await waitForJobs(store, 1, "running");
      await waitForJobs(store, 2, "queued");
      const completed = await waitForTerminalJobs(store, 3, 5_000);
      expect(completed.every((job) => job.status === "completed")).toBe(true);
      const startedOrder = (await store.listJobs())
        .slice()
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
        .map((job) => JSON.parse(job.context.event) as { n: number })
        .map((event) => event.n);
      expect(startedOrder).toEqual([1, 2, 3]);
      await delivery.shutdown();
    });
  });

  test("pending delivery timers are restored after restart", async () => {
    await withTempStore(async (store) => {
      const trig = trigger({
        id: "restore",
        delivery: { mode: { strategy: "batched", window: "80ms", maxBatch: 10 }, maxConcurrent: 1 },
      });
      const first = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await first.init([trig]);
      await first.handle(trig, { triggerId: trig.id, source: "manual", payload: "a", receivedAt: new Date().toISOString() });
      await first.shutdown();

      const second = new DeliveryManager(store, new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 }));
      await second.init([trig]);
      const [completed] = await waitForTerminalJobs(store, 1);
      expect(completed.triggerId).toBe("restore");
      expect(completed.context.batch_count).toBe("1");
      await second.shutdown();
    });
  });
});

describe("context and actions", () => {
  test("context sources run in parallel and partial failures only warn", async () => {
    await withTempStore(async (_store, root) => {
      const file = join(root, "context.txt");
      await writeFile(file, "file-value");
      const trig = trigger({
        context: {
          static: { static_value: "static" },
          sources: [
            { var: "one", kind: "command", command: "node -e \"setTimeout(()=>console.log('one'),100)\"" },
            { var: "two", kind: "command", command: "node -e \"setTimeout(()=>console.log('two'),100)\"" },
            { var: "file", kind: "file", path: file },
            { var: "bad", kind: "command", command: "exit 7" },
          ],
        },
      });
      const started = Date.now();
      const resolved = await resolveContext(trig, { triggerId: trig.id, source: "manual", payload: {}, receivedAt: new Date().toISOString() }, { defaultTimeoutMs: 1000 });
      expect(Date.now() - started).toBeLessThan(180);
      expect(resolved.context.one).toBe("one");
      expect(resolved.context.two).toBe("two");
      expect(resolved.context.file).toBe("file-value");
      expect(resolved.context.static_value).toBe("static");
      expect(resolved.warnings.some((warning) => warning.includes("bad"))).toBe(true);
    });
  });

  test("http and honeybee context sources resolve into template vars", async () => {
    await withTempStore(async (_store, root) => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ value: "from-http" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "hive"), "#!/bin/sh\necho from-hive\n");
      await chmod(join(bin, "hive"), 0o700);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}:${previousPath ?? ""}`;
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("server did not bind");
        const trig = trigger({
          context: {
            sources: [
              { var: "http_value", kind: "http", url: `http://127.0.0.1:${address.port}`, jsonpath: "$.value" },
              { var: "hive_value", kind: "honeybee", query: "search topic" },
            ],
          },
        });
        const resolved = await resolveContext(trig, { triggerId: trig.id, source: "manual", payload: {}, receivedAt: new Date().toISOString() }, { defaultTimeoutMs: 1000 });
        expect(resolved.context.http_value).toBe("from-http");
        expect(resolved.context.hive_value).toBe("from-hive");
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    });
  });

  test("command and http actions execute, while dry-run only renders", async () => {
    await withTempStore(async (store, root) => {
      const out = join(root, "out");
      await mkdir(root, { recursive: true });
      const commandTrigger = trigger({
        id: "command",
        action: { kind: "command", command: `node -e "require('fs').writeFileSync('${out}', 'hello {{name}}')"`, timeout: "1s" },
        context: { static: { name: "world" } },
      });
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const activation = { triggerId: commandTrigger.id, source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
      const dry = await executor.dryRun(commandTrigger, activation, [{}]);
      expect(dry.action.kind).toBe("command");
      await expect(readFile(out, "utf8")).rejects.toThrow();

      const job = await executor.createQueuedJob(commandTrigger, activation, [{}]);
      await store.saveJob(job);
      const completed = await executor.executeJob(job, commandTrigger, activation, [{}]);
      expect(completed.status).toBe("completed");
      expect(await readFile(out, "utf8")).toBe("hello world");

      const server = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ method: request.method, body }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("server did not bind");
        const httpTrigger = trigger({
          id: "http",
          action: { kind: "http", method: "POST", url: `http://127.0.0.1:${address.port}`, body: "{{event}}", timeout: "1s" },
        });
        const httpActivation = { triggerId: "http", source: "manual" as const, payload: { ok: true }, receivedAt: new Date().toISOString() };
        const httpJob = await executor.createQueuedJob(httpTrigger, httpActivation, [httpActivation.payload]);
        await store.saveJob(httpJob);
        const httpCompleted = await executor.executeJob(httpJob, httpTrigger, httpActivation, [httpActivation.payload]);
        expect(httpCompleted.status).toBe("completed");
        const httpResult = httpCompleted.result as { body: string };
        expect(JSON.parse(httpResult.body).body).toBe('{"ok":true}');
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    });
  });

  test("trigger cwd is inherited by context commands, actions, and jobs", async () => {
    await withTempStore(async (store, root) => {
      const repo = join(root, "repo");
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, "marker.txt"), "repo-marker");
      const trig = trigger({
        id: "cwd",
        cwd: repo,
        context: {
          sources: [
            { var: "marker", kind: "command", command: "node -e \"process.stdout.write(require('fs').readFileSync('marker.txt', 'utf8'))\"" },
          ],
        },
        action: { kind: "command", command: "node -e \"require('fs').writeFileSync('out.txt', '{{marker}}:' + process.cwd())\"", timeout: "1s" },
      });
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const activation = { triggerId: trig.id, source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
      const job = await executor.createQueuedJob(trig, activation, [{}]);
      expect(job.cwd).toBe(repo);
      await store.saveJob(job);

      const completed = await executor.executeJob(job, trig, activation, [{}]);
      expect(completed.status).toBe("completed");
      expect(completed.cwd).toBe(repo);
      expect(completed.context.marker).toBe("repo-marker");
      expect(await readFile(join(repo, "out.txt"), "utf8")).toBe(`repo-marker:${await realpath(repo)}`);
    });
  });

  test("local command cwd overrides the trigger cwd", async () => {
    await withTempStore(async (store, root) => {
      const defaultRepo = join(root, "default");
      const overrideRepo = join(root, "override");
      await mkdir(defaultRepo, { recursive: true });
      await mkdir(overrideRepo, { recursive: true });
      await writeFile(join(defaultRepo, "marker.txt"), "default");
      await writeFile(join(overrideRepo, "marker.txt"), "override");
      const trig = trigger({
        id: "cwd-override",
        cwd: defaultRepo,
        context: {
          sources: [
            {
              var: "marker",
              kind: "command",
              command: "node -e \"process.stdout.write(require('fs').readFileSync('marker.txt', 'utf8'))\"",
              cwd: overrideRepo,
            },
          ],
        },
        action: {
          kind: "command",
          command: "node -e \"require('fs').writeFileSync('out.txt', '{{marker}}:' + process.cwd())\"",
          cwd: overrideRepo,
          timeout: "1s",
        },
      });
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const activation = { triggerId: trig.id, source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
      const job = await executor.createQueuedJob(trig, activation, [{}]);
      await store.saveJob(job);

      const completed = await executor.executeJob(job, trig, activation, [{}]);
      expect(completed.status).toBe("completed");
      expect(completed.cwd).toBe(defaultRepo);
      expect(completed.context.marker).toBe("override");
      expect(await readFile(join(overrideRepo, "out.txt"), "utf8")).toBe(`override:${await realpath(overrideRepo)}`);
      await expect(readFile(join(defaultRepo, "out.txt"), "utf8")).rejects.toThrow();
    });
  });

  test("queued jobs use their snapshotted action and cwd", async () => {
    await withTempStore(async (store, root) => {
      const firstRepo = join(root, "first");
      const secondRepo = join(root, "second");
      await mkdir(firstRepo, { recursive: true });
      await mkdir(secondRepo, { recursive: true });
      const originalOut = join(root, "original.txt");
      const editedOut = join(root, "edited.txt");
      const trig = trigger({
        id: "snapshot",
        cwd: firstRepo,
        action: { kind: "command", command: `node -e "require('fs').writeFileSync('${originalOut}', process.cwd())"`, timeout: "1s" },
      });
      const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
      const activation = { triggerId: trig.id, source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
      const job = await executor.createQueuedJob(trig, activation, [{}]);
      await store.saveJob(job);

      const editedTrigger = {
        ...trig,
        cwd: secondRepo,
        action: { kind: "command" as const, command: `node -e "require('fs').writeFileSync('${editedOut}', process.cwd())"`, timeout: "1s" },
      };
      const completed = await executor.executeJob(job, editedTrigger, activation, [{}]);
      expect(completed.status).toBe("completed");
      expect(completed.cwd).toBe(firstRepo);
      expect(await readFile(originalOut, "utf8")).toBe(await realpath(firstRepo));
      await expect(readFile(editedOut, "utf8")).rejects.toThrow();
    });
  });

  test("honeybee and hermes actions invoke their CLIs without in-process execution", async () => {
    await withTempStore(async (store, root) => {
      const hive = await installHiveStub(root);
      const hiveLog = hive.logPath;
      const hermesLog = join(root, "hermes.log");
      await installCommandStub(root, "hermes", `#!/bin/sh\necho "$@" >> "${hermesLog}"\ncat >/dev/null\n`, hermesLog);
      try {
        const executor = new ActionExecutor(store, { contextTimeoutMs: 1000, commandTimeoutMs: 1000 });
        const flow = trigger({
          id: "flow",
          action: { kind: "honeybee", run: "flow", flow: "review", args: { topic: "{{topic}}" } },
          context: { static: { topic: "auth" } },
        });
        const flowActivation = { triggerId: "flow", source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
        const flowJob = await executor.createQueuedJob(flow, flowActivation, [{}]);
        await store.saveJob(flowJob);
        expect((await executor.executeJob(flowJob, flow, flowActivation, [{}])).status).toBe("completed");
        expect(await readFile(hiveLog, "utf8")).toContain("flow run review --arg topic=auth");

        const loop = trigger({ id: "loop", action: { kind: "honeybee", run: "loop", loop: { bee: "codex", cwd: root, max: 2 } } });
        const loopActivation = { triggerId: "loop", source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
        const loopJob = await executor.createQueuedJob(loop, loopActivation, [{}]);
        await store.saveJob(loopJob);
        expect((await executor.executeJob(loopJob, loop, loopActivation, [{}])).status).toBe("completed");
        expect(await readFile(hiveLog, "utf8")).toContain(`loop start --bee codex --cwd ${root} --max 2`);

        const defaultLoop = trigger({ id: "loop-default", cwd: root, action: { kind: "honeybee", run: "loop", loop: { bee: "codex", max: 2 } } });
        const defaultLoopActivation = { triggerId: "loop-default", source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
        const defaultLoopJob = await executor.createQueuedJob(defaultLoop, defaultLoopActivation, [{}]);
        await store.saveJob(defaultLoopJob);
        expect((await executor.executeJob(defaultLoopJob, defaultLoop, defaultLoopActivation, [{}])).status).toBe("completed");
        expect(await readFile(hiveLog, "utf8")).toContain(`loop start --bee codex --max 2 --cwd ${root}`);

        const hermes = trigger({ id: "hermes", action: { kind: "hermes", invoke: "respond", payload: '{"ok":true}' } });
        const hermesActivation = { triggerId: "hermes", source: "manual" as const, payload: {}, receivedAt: new Date().toISOString() };
        const hermesJob = await executor.createQueuedJob(hermes, hermesActivation, [{}]);
        await store.saveJob(hermesJob);
        expect((await executor.executeJob(hermesJob, hermes, hermesActivation, [{}])).status).toBe("completed");
        expect(await readFile(hermesLog, "utf8")).toContain("respond");
      } finally {
        hive.restore();
      }
    });
  });
});
