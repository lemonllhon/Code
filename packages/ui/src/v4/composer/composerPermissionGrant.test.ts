import assert from "node:assert/strict";
import test from "node:test";
import { applyComposerPermissionGrant } from "./composerPermissionGrant.js";
import { refreshUneditedNewTaskDefaults } from "./newTaskDraft.js";

test("confirmed modes survive defaults refresh and stale grant replay", () => {
  const initial = { text: "", mode: "yolo" as const, updatedAt: 1 };
  const confirmed = applyComposerPermissionGrant(initial, {
    interactionId: "change",
    mode: "edit",
  });
  assert.equal(confirmed.mode, "edit");
  assert.equal(confirmed.approvalModeEdited, true);
  assert.equal(
    applyComposerPermissionGrant(confirmed, { interactionId: "change", mode: "edit" }),
    confirmed,
  );
  assert.equal(applyComposerPermissionGrant(initial, { interactionId: "legacy" }).mode, "yolo");
  const view = { providers: [], revision: 1 } as unknown as Parameters<
    typeof refreshUneditedNewTaskDefaults
  >[1];
  assert.equal(
    refreshUneditedNewTaskDefaults(confirmed, view, { approvalMode: "build" }).mode,
    "edit",
  );
  assert.equal(applyComposerPermissionGrant(initial, { interactionId: "stale" }, "build"), initial);
});
