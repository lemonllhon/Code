import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ModelSelection } from "@lcode/contracts";
import { persistRuntimeModelSelection, persistSessionModelSelection } from "./turn-model.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import type { SessionStorePort } from "../deps.js";

test("draft selection waits for the parent and all callers serialize immutable snapshots", async () => {
  const writes: unknown[] = [];
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  let selection = {
    providerId: "fixture",
    modelId: "first",
    options: { reasoningLevel: "low" },
  } as ModelSelection;
  const runtime = {
    sessionId: "fixture",
    sessionPersisted: false,
    getSessionModelSelection: () => selection,
    sessionStore: {
      async saveSessionEntry(entry: { data: unknown }) {
        writes.push(entry.data);
        if (writes.length === 1) await firstWrite;
      },
    },
  } as unknown as AgentRuntimeInternal;
  assert.equal(await persistSessionModelSelection.call(runtime), "deferred");
  assert.deepEqual(writes, []);
  runtime.sessionPersisted = true;
  const first = persistRuntimeModelSelection(runtime, selection);
  selection.options!.reasoningLevel = "high";
  selection = { ...selection, modelId: "latest" as ModelSelection["modelId"] };
  const latest = persistSessionModelSelection.call(runtime);
  await Promise.resolve();
  assert.equal(writes.length, 1);
  release();
  await Promise.all([first, latest]);
  assert.deepEqual(writes, [
    { providerId: "fixture", modelId: "first", options: { reasoningLevel: "low" } },
    { providerId: "fixture", modelId: "latest", options: { reasoningLevel: "high" } },
  ]);
});

test("first activity creates the parent before writing the latest draft selection", async () => {
  const { runtime } = createMockRuntime({ workingDirectory: "/fixture" });
  let parent = false;
  const selections: unknown[] = [];
  Object.assign(runtime, {
    sessionStore: {
      async createSession() {
        parent = true;
        return {};
      },
      async saveSessionEntry(entry: { type: string; touchSession: boolean; data: unknown }) {
        assert.equal(parent, true);
        if (entry.type === "runtime/model_selection") {
          assert.equal(entry.touchSession, false);
          selections.push(entry.data);
        }
      },
    } as unknown as SessionStorePort,
  });
  runtime.setSessionModelSelection({ providerId: "fixture", modelId: "draft" } as ModelSelection);
  await runtime.persistSessionModelSelection();
  assert.equal(parent, false);
  runtime.setSessionModelSelection({
    providerId: "fixture",
    modelId: "latest",
    options: { reasoningLevel: "high" },
  } as ModelSelection);
  await runtime.persistSessionModelSelection();
  await runtime.ensureSessionPersisted("fixture", runtime.rootTraceContext);
  assert.deepEqual(selections, [
    { providerId: "fixture", modelId: "latest", options: { reasoningLevel: "high" } },
  ]);
});

test("failed persistence is explicit and does not poison subsequent writes", async () => {
  let attempts = 0;
  const runtime = {
    sessionId: "fixture",
    sessionPersisted: true,
    getSessionModelSelection: () => ({ providerId: "fixture", modelId: "fixture" }),
    sessionStore: {
      async saveSessionEntry() {
        if (++attempts === 1) throw new Error("fixture failure");
      },
    },
  } as unknown as AgentRuntimeInternal;
  assert.equal(await persistSessionModelSelection.call(runtime), "failed");
  assert.equal(await persistSessionModelSelection.call(runtime), "persisted");
  assert.equal(attempts, 2);
});
