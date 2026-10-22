import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalBackupJson,
  backupSelectionKey,
  retainedBackupCandidates,
} from "../domain/backupRules.js";
import type { BackupVersion } from "../contract.js";
test("fingerprints ignore object key order, preserve semantic array order and values", () => {
  assert.equal(canonicalBackupJson({ b: 2, a: [1, 2] }), canonicalBackupJson({ a: [1, 2], b: 2 }));
  assert.notEqual(canonicalBackupJson([1, 2]), canonicalBackupJson([2, 1]));
  assert.equal(
    backupSelectionKey({ providerIds: ["b", "a", "a"] }),
    backupSelectionKey({ providerIds: ["a", "b"] }),
  );
});
test("retention isolates writers, full collections and partial scopes", () => {
  const version = (id: string, sourceId = "ours", scope = "all", rollback = false) =>
    ({
      id,
      sourceId,
      scope,
      rollback,
      kind: "providers",
      targetKey: "profile",
      location: "local",
      createdAt: id,
    }) as BackupVersion;
  const versions = [
    version("1"),
    version("2"),
    version("3", "other"),
    version("4", "ours", "partial"),
    version("5", "ours", "all", true),
  ];
  assert.deepEqual(
    retainedBackupCandidates(versions, 1, "ours").map((v) => v.id),
    ["1"],
  );
  assert.deepEqual(retainedBackupCandidates(versions, null, "ours"), []);
});
