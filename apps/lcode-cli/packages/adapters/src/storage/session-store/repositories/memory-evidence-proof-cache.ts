import type { DatabaseSync } from "node:sqlite";

const proofs = new WeakMap<DatabaseSync, { epoch: string; key?: string }>();
/** 仅缓存控制证明，正文始终重读。连接任意写入或另一连接提交都会使派生证明失效。 */
export function memoryEvidenceProof(
  db: DatabaseSync,
  key: string,
): { valid: boolean; remember(): void } {
  const version = db.prepare("pragma data_version").get()!.data_version;
  const changes = db.prepare("select total_changes() as changes").get()!.changes;
  const epoch = `${version}:${changes}`;
  let state = proofs.get(db);
  if (state?.epoch !== epoch) {
    state = { epoch };
    proofs.set(db, state);
  }
  return {
    valid: state.key === key,
    remember: () => {
      state.key = key;
    },
  };
}
