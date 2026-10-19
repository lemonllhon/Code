import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  type CommandEnvelope,
  type ConversationSnapshot,
} from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { modelConfigHandlers } from "./commands/handlers/model-config.js";
import type { V4CommandCoreHost } from "./commands/types.js";

test("the menu delegates all permission modes to the same Runtime owner with command identity", async () => {
  const received: unknown[] = [];
  const host = {
    getRecord: () => ({
      app: {
        runtime: {
          setPermissionMode: async (...input: unknown[]) => {
            received.push(input);
          },
        },
        setMode: () => {
          throw Error("parallel mutation path");
        },
      },
    }),
  } as unknown as V4CommandCoreHost;
  for (const mode of ["build", "edit", "yolo"])
    await modelConfigHandlers.switchCollaborationMode(host, {
      sessionId: "fixture",
      commandId: `command-${mode}`,
      payload: { mode },
    } as CommandEnvelope);
  assert.deepEqual(received, [
    ["build", "command-build"],
    ["edit", "command-edit"],
    ["yolo", "command-yolo"],
  ]);
});

for (const delivery of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`${delivery}: mode switch updates queue and grant; replay and cold seed preserve current authority`, () => {
    const owner = new ProductProjection("fixture", "epoch");
    let client: ConversationSnapshot = structuredClone(owner.getSnapshot());
    let sequence = 0;
    const events: SessionEvent[] = [];
    const emit = (type: SessionEvent["type"], payload: unknown) => {
      const event = {
        id: `event-${++sequence}`,
        type,
        payload,
        sessionId: "fixture",
        traceId: "trace",
        timestamp: new Date(sequence * 10),
        sequenceNumber: sequence,
      } as SessionEvent;
      events.push(event);
      client = { ...applyConversationDeltas(client, owner.applyEvent(event)), seq: sequence };
      conversationSnapshotSchema.parse(client);
      assert.deepEqual(client, owner.getSnapshot());
    };
    for (const id of ["queued", "other"])
      emit(SessionEventType.TurnSteerQueued, {
        pendingInputId: id,
        input: "fixture",
        queueLength: 1,
        intent: {
          queueItemId: id,
          sourceCommandId: id,
          mode: "build",
          planEnabled: true,
          modelSelection: { providerId: "fixture", modelId: "frozen" },
          requestedDelivery: "queue",
          admittedDelivery: "queue",
          admissionSeq: 1,
          admittedAt: 1,
        },
      });
    for (const mode of ["yolo", "edit", "build"] as const) {
      emit(SessionEventType.SessionModeChanged, {
        mode,
        planEnabled: true,
        source: "command",
        permissionGrant: { interactionId: `grant-${mode}`, queueItemIds: ["queued"] },
      });
      assert.equal(client.queue.items[0]!.mode, mode);
      assert.equal(client.queue.items[1]!.mode, "build");
      assert.equal(client.queue.items[0]!.modelSelection!.modelId, "frozen");
      assert.equal(client.config.permissionGrant!.mode, mode);
      assert.equal(client.config.permissionModeVersion, `event-${sequence}`);
    }
    emit(SessionEventType.SessionModeChanged, {
      mode: "yolo",
      planEnabled: false,
      source: "command",
      permissionGrant: { interactionId: "old-yolo", queueItemIds: [] },
    });
    emit(SessionEventType.SessionModeChanged, {
      mode: "build",
      planEnabled: false,
      source: "command",
    });
    assert.equal(client.config.permissionGrant, undefined);
    owner.seedConfig({
      mode: "build",
      permissionGrant: { interactionId: "old-yolo", mode: "yolo" },
    });
    assert.equal(
      owner.getSnapshot().config.permissionGrant,
      undefined,
      "cold seed must not restore an obsolete grant",
    );
    const recovered = new ProductProjection("fixture", "epoch");
    for (const event of events) recovered.applyEvent(event);
    assert.deepEqual(recovered.getSnapshot(), owner.getSnapshot());
  });
}
