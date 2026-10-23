import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity, projectContextForDefinition } from "@lcode/shared";
import type { CommandEnvelope, QueueItem } from "@lcode/shared/lcode-protocol-v4";
import {
  inputIntentMetadata,
  inputIntentMetadataFromCanonical,
  inputIntentMetadataFromQueueItem,
} from "./input-intent.js";
import { resolveInputCommandForAdmission } from "../../lcode-protocol/v4-bridge-admission-input.js";

const accepted = projectContextForDefinition(
  {
    id: "synthetic",
    revision: 4,
    name: "Synthetic",
    primaryFolderPath: "/app",
    sourceFolderPaths: ["/app"],
  },
  { workspacePath: "/app" },
);
accepted.members.push({
  ...accepted.members[0]!,
  memberId: "remote",
  workspaceIdentity: buildRemoteWorkspaceIdentity("/app", {
    kind: "ssh",
    host: "fixture.example.test",
    username: "fixture",
  }),
  routeToken: "synthetic-token",
});
accepted.execution = { ...accepted.members[1]! };
const envelope = {
  commandId: "synthetic-command",
  clientId: "synthetic-client",
  sessionId: "synthetic-session",
  type: "sendText",
  payload: { text: "synthetic input" },
  issuedAt: 1,
  __v4Admission: {
    admissionSeq: 3,
    admittedAt: 1,
    queueItemId: "synthetic-queue",
    projectContext: structuredClone(accepted),
  },
} as unknown as CommandEnvelope;

for (const delivery of ["startNow", "queue", "guide"] as const) {
  test(`${delivery}: accepted scope survives input metadata, serialization and queue promotion`, () => {
    const intent = inputIntentMetadata(envelope, {
      text: "synthetic input",
      requestedDelivery: delivery,
    });
    assert.deepEqual(intent.projectContext, accepted);
    const item = JSON.parse(
      JSON.stringify({
        ...intent,
        attachments: [],
        delivery: { requested: delivery, admitted: delivery },
        order: { admissionSeq: 3 },
        admittedAt: 1,
      }),
    ) as QueueItem;
    const promoted = inputIntentMetadataFromQueueItem(item, "promoted text");
    assert.deepEqual(promoted.projectContext, accepted);
    assert.equal(promoted.sourceCommandId, intent.sourceCommandId);
    assert.equal(promoted.queueItemId, intent.queueItemId);
    assert.equal(
      promoted.projectContext?.members[1]?.workspaceIdentity,
      accepted.members[1]?.workspaceIdentity,
    );
  });
}

for (const type of ["retryTurn", "editUserQuery"] as const) {
  test(`${type}: historical canonical scope wins over later project admission configuration`, () => {
    const restored = JSON.parse(
      JSON.stringify({
        kind: "sendText",
        text: "original",
        sourceCommandId: "original-command",
        projectContext: accepted,
      }),
    );
    const command = {
      ...envelope,
      type,
      payload: {
        target: { rowId: 1, entityId: "synthetic-user" },
        ...(type === "editUserQuery" ? { newText: "edited" } : {}),
      },
    } as CommandEnvelope;
    const resolved = resolveInputCommandForAdmission(
      command,
      "synthetic-session",
      () => ({ ok: true, editTarget: { intent: restored } }) as never,
    );
    assert.ok(resolved);
    assert.deepEqual(resolved.projectContext, accepted);
    const intent = inputIntentMetadataFromCanonical(
      envelope,
      resolved as never,
      resolved.text ?? "",
    );
    assert.deepEqual(intent.projectContext, accepted);
    assert.equal(intent.provenance?.sourceCommandId, "original-command");
  });
}
