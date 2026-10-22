import type { BackupKind, BackupRequest, BackupSnapshot, BackupVersion } from "../contract.js";
import type { BackupEnginePorts, BackupObjectStore, BackupSourcePort } from "./ports.js";
import type { createBackupCatalog } from "./backupCatalog.js";
import { backupRequestSchema } from "../domain/backupSchemas.js";
import { canonicalBackupJson, backupSelectionKey } from "../domain/backupRules.js";
const ROOT = "lcode-backup/v2/";
export function createBackupCapture(
  ports: BackupEnginePorts,
  catalog: ReturnType<typeof createBackupCatalog>,
  resolveSource: (kind: BackupKind) => BackupSourcePort,
) {
  const { readVersion, cleanup } = catalog;
  async function capture(
    request: BackupRequest,
    snapshot?: BackupSnapshot,
    admittedStores?: BackupObjectStore[],
  ) {
    request = backupRequestSchema.parse(request);
    const operationKey = `backup:${request.operationId}`;
    const previous = await ports.state((state) =>
      Object.hasOwn(state.operations, operationKey) ? state.operations[operationKey] : undefined,
    );
    if (previous) return previous as import("../contract.js").BackupResult;
    const stores = admittedStores ?? (await ports.destinations(request));
    const data =
      snapshot ?? (await resolveSource(request.kind).capture(request.selection, request.target));
    if (!stores.length) throw new Error("No backup location selected");
    const sourceId = await ports.state((state) => state.sourceId);
    const scope = backupSelectionKey(data.selection);
    const fingerprint = ports.digest(canonicalBackupJson(data));
    const targetHash = ports.digest(`${data.targetKey}:${scope}`).slice(0, 24);
    const intentKey = ports.digest(
      canonicalBackupJson([data.kind, data.targetKey, scope, fingerprint]),
    );
    const intent = await ports.state((state) => {
      state.pendingCaptures ??= {};
      const previous = state.pendingCaptures[intentKey];
      if (previous) return { ...previous, reused: true };
      const accepted = {
        id: `${sourceId}/${data.kind}/${targetHash}/${ports.id()}`,
        createdAt: new Date(ports.now()).toISOString(),
      };
      state.pendingCaptures[intentKey] = accepted;
      return { ...accepted, reused: false };
    });
    const { id, createdAt } = intent;
    const results: Omit<
      import("../contract.js").BackupResult["results"][number],
      "locationRevision"
    >[] = [];
    let archive: Awaited<ReturnType<typeof ports.seal>> | undefined;
    async function archiveForRun() {
      if (archive) return archive;
      const staged = await ports.staging?.get(`${ROOT}${id}/archive.json`);
      if (staged) {
        const snapshot = await ports.open(staged);
        if (ports.digest(canonicalBackupJson(snapshot)) !== fingerprint)
          throw new Error("Staged backup content does not match its admission");
        archive = { bytes: staged, keyId: JSON.parse(new TextDecoder().decode(staged)).keyId };
      } else {
        const sealed = await ports.seal(data);
        await ports.staging?.put(`${ROOT}${id}/archive.json`, sealed.bytes);
        archive = sealed;
      }
      return archive;
    }
    for (const store of stores) {
      const checkpointKey = `${data.kind}:${store.location}:${ports.digest(canonicalBackupJson([data.targetKey, scope, store.revision, 2]))}`;
      try {
        const checkpoint = await ports.state((state) => state.checkpoints[checkpointKey]);
        if (checkpoint?.fingerprint === fingerprint) {
          const existing = await readVersion(store, checkpoint.id);
          if (
            existing?.fingerprint === fingerprint &&
            (store.exists
              ? await store.exists(`${ROOT}${checkpoint.id}/archive.json`)
              : await store.get(`${ROOT}${checkpoint.id}/archive.json`))
          ) {
            results.push({
              location: store.location,
              status: "skipped-unchanged",
              version: existing.version,
            });
            continue;
          }
        }
        const completed = intent.reused ? await readVersion(store, id) : null;
        if (completed?.fingerprint === fingerprint) {
          await ports.state((state) => {
            state.checkpoints[checkpointKey] = { fingerprint, id };
          });
          results.push({ location: store.location, status: "created", version: completed.version });
          continue;
        }
        archive = await archiveForRun();
        const version: BackupVersion = {
          id,
          sourceId,
          kind: data.kind,
          targetKey: data.targetKey,
          scope,
          createdAt,
          label: data.label,
          items: data.items,
          size: archive.bytes.length,
          location: store.location,
          locationRevision: ports.digest(store.revision),
          keyId: archive.keyId,
          format: 2,
        };
        const archiveDigest = ports.digest(new TextDecoder().decode(archive.bytes));
        const marker = await ports.seal({ version, fingerprint, archiveDigest });
        await store.put(`${ROOT}${id}/archive.json`, archive.bytes);
        await store.put(`${ROOT}${id}/manifest.json`, marker.bytes);
        await ports.state((state) => {
          state.checkpoints[checkpointKey] = { fingerprint, id };
        });
        results.push({ location: store.location, status: "created", version });
        try {
          await cleanup(store);
        } catch {
          await ports.state((state) => {
            state.error = `${store.location}: backup succeeded, cleanup failed`;
          });
        }
      } catch (error) {
        results.push({
          location: store.location,
          status: "failed",
          error: error instanceof Error ? error.message : "Backup failed",
        });
      }
    }
    const result: import("../contract.js").BackupResult = {
      operationId: request.operationId,
      results: results.map((item) => ({
        ...item,
        locationRevision: ports.digest(
          stores.find((store) => store.location === item.location)!.revision,
        ),
      })),
    };
    await ports.state((state) => {
      state.lastCheckAt = new Date(ports.now()).toISOString();
      state.lastResult = result;
      state.operations[operationKey] = result;
      for (const expired of Object.keys(state.operations).slice(0, -256))
        delete state.operations[expired];
      if (results.every((result) => result.status !== "failed"))
        delete state.pendingCaptures?.[intentKey];
    });
    if (results.every((result) => result.status !== "failed"))
      await ports.staging?.remove(`${ROOT}${id}/archive.json`).catch(() =>
        ports.state((state) => {
          state.error = "Backup succeeded, staging cleanup failed";
        }),
      );
    return result;
  }
  return capture;
}
