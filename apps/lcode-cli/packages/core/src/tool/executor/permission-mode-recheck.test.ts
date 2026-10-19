import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import { PermissionService } from "../../permission/service.js";
import { ToolRegistryImpl } from "../registry.js";
import type { ToolEntry } from "../types.js";
import { createToolExecutor } from "./impl.js";
import type { ToolExecutorOptions } from "./types.js";

const tick = () => new Promise<void>((done) => setImmediate(done));
function fixture(
  options: {
    alwaysAsk?: boolean;
    userOnly?: boolean;
    hookAsk?: boolean;
    initialMode?: "build" | "yolo";
    handlerGate?: Promise<void>;
    hookGate?: Promise<void>;
  } = {},
) {
  let mode: "build" | "yolo" = options.initialMode ?? "build",
    planEnabled = false;
  const listeners = new Set<() => void>(),
    started: string[] = [],
    events: SessionEvent[] = [];
  const answers = new Map<string, (result: { decision: "allow" | "deny" }) => void>();
  let aborted = 0;
  const registry = new ToolRegistryImpl();
  registry.register({
    metadata: {
      name: "Fixture",
      readOnly: false,
      concurrentSafe: false,
      destructive: false,
      needsApproval: true,
      sideEffectScope: "workspace",
      riskLevel: "medium",
    },
    permission: {
      alwaysAsk: options.alwaysAsk,
      approvalSource: options.userOnly ? "user" : undefined,
    },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handler: async (_input, context) => {
      started.push(context.toolCallId);
      if (context.toolCallId === "one") await options.handlerGate;
      return {};
    },
  } as unknown as ToolEntry);
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(),
    sessionId: "fixture" as never,
    getMode: () => mode,
    maxConcurrency: 1,
    sessionModePort: {
      getMode: () => mode,
      getPrePlanMode: () => undefined,
      isPlanEnabled: () => planEnabled,
      onPermissionChanged: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as ToolExecutorOptions["sessionModePort"],
    permissionBroker: {
      requestPermission: (request, brokerOptions) =>
        new Promise((resolve, reject) => {
          answers.set(request.toolCallId, resolve);
          brokerOptions?.signal?.addEventListener(
            "abort",
            () => {
              aborted++;
              reject(Error("broker aborted"));
            },
            { once: true },
          );
        }),
    } as ToolExecutorOptions["permissionBroker"],
    ...(options.hookAsk || options.hookGate
      ? {
          hookRunner: {
            run: async (context: { hookEventName: string }) => {
              if (context.hookEventName === "PreToolUse") await options.hookGate;
              return {
                ...(context.hookEventName === "PreToolUse" && options.hookAsk
                  ? { permissionBehavior: "ask" }
                  : {}),
                additionalContexts: [],
              };
            },
          } as never,
        }
      : {}),
    emitEvent: async (event) => {
      events.push(event);
    },
  });
  return {
    started,
    events,
    listeners,
    answers,
    aborted: () => aborted,
    run: (id: string, signal?: AbortSignal) =>
      executor.execute({ id, name: "Fixture", input: {} } as never, { signal }),
    set: (next: "build" | "yolo") => {
      mode = next;
      listeners.forEach((listener) => listener());
    },
    change: (plan = false) => {
      mode = "yolo";
      planEnabled = plan;
      listeners.forEach((listener) => listener());
    },
  };
}

test("committed full access releases all ordinary pending approvals through their original lifecycle", async () => {
  const f = fixture();
  const pending = [f.run("one"), f.run("two")];
  await tick();
  assert.equal(f.answers.size, 2);
  assert.deepEqual(f.started, []);
  f.change();
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.success));
  assert.equal(f.started.length, 2);
  assert.equal(
    f.events.filter((event) => event.type === SessionEventType.PermissionResolved).length,
    2,
  );
  assert.equal(f.listeners.size, 0);
  assert.equal(f.aborted(), 2);
});

for (const options of [{ alwaysAsk: true }, { userOnly: true }, { hookAsk: true }]) {
  test(`full access preserves mandatory confirmation ${JSON.stringify(options)}`, async () => {
    const f = fixture(options),
      pending = f.run("one");
    await tick();
    f.change();
    await tick();
    assert.deepEqual(f.started, []);
    f.answers.get("one")!({ decision: "allow" });
    assert.equal((await pending).success, true);
    assert.equal(f.listeners.size, 0);
  });
}

test("Plan enabled during a pending write rejects it instead of consuming an old allow", async () => {
  const f = fixture(),
    pending = f.run("one");
  await tick();
  f.change(true);
  const result = await pending;
  assert.equal(result.success, false);
  assert.deepEqual(f.started, []);
  assert.equal(f.listeners.size, 0);
});

test("downgrading while waiting for an execution permit rechecks before the handler starts", async () => {
  let release!: () => void;
  const f = fixture({
    initialMode: "yolo",
    handlerGate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const one = f.run("one"),
    two = f.run("two");
  await tick();
  assert.deepEqual(f.started, ["one"]);
  assert.equal(f.answers.size, 0);
  f.set("build");
  release();
  await one;
  await tick();
  assert.deepEqual(f.started, ["one"]);
  assert.equal(f.answers.size, 1);
  // 等待审批不占执行槽，第三个普通批准仍可正常完成。
  const three = f.run("three");
  await tick();
  f.answers.get("three")!({ decision: "allow" });
  assert.equal((await three).success, true);
  f.answers.get("two")!({ decision: "allow" });
  assert.equal((await two).success, true);
  assert.deepEqual(f.started, ["one", "three", "two"]);
});

test("a mode selected while PreToolUse is pending is used by the first permission decision", async () => {
  let release!: () => void;
  const f = fixture({
    hookGate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const pending = f.run("one");
  await tick();
  f.set("yolo");
  release();
  assert.equal((await pending).success, true);
  assert.equal(f.answers.size, 0);
});

test("cancellation removes mode listeners and a later grant cannot start the cancelled tool", async () => {
  const f = fixture(),
    controller = new AbortController();
  const pending = f.run("one", controller.signal);
  await tick();
  controller.abort();
  assert.equal((await pending).success, false);
  f.change();
  await tick();
  assert.deepEqual(f.started, []);
  assert.equal(f.listeners.size, 0);
});
