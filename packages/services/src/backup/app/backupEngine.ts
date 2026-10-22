import { createBackupCapture } from "./backupCapture.js";
import { createBackupCatalog } from "./backupCatalog.js";
import { createBackupPackages } from "./backupPackages.js";
import { backupPolicyInputSchema, backupRestoreRequestSchema } from "../domain/backupSchemas.js";
import type {
  BackupCleanupPreview,
  BackupKind,
  BackupRestoreResult,
  BackupSnapshot,
  IBackupLifecycleService,
} from "../contract.js";
import {
  canonicalBackupJson,
  retainedBackupCandidates,
  validateBackupPolicy,
} from "../domain/backupRules.js";
import type { BackupEnginePorts } from "./ports.js";
const ROOT = "lcode-backup/v2/";
function validateOperation(id: string) {
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
    ["__proto__", "constructor", "prototype"].includes(id)
  )
    throw new Error("Invalid backup operation ID");
}
function source(ports: BackupEnginePorts, kind: BackupKind) {
  const port = ports.sources[kind];
  if (!port) throw new Error("Backup source is unavailable on this Host");
  return port;
}
export function createBackupEngine(ports: BackupEnginePorts) {
  let running = false;
  async function mutate<T>(operation: () => Promise<T>) {
    return ports.exclusive(async () => {
      running = true;
      try {
        return await operation();
      } finally {
        running = false;
      }
    });
  }
  async function record<T>(kind: string, id: string, operation: () => Promise<T>): Promise<T> {
    validateOperation(id);
    const key = `${kind}:${id}`;
    const previous = await ports.state((state) =>
      Object.hasOwn(state.operations, key) ? state.operations[key] : undefined,
    );
    if (previous !== undefined) return previous as T;
    const result = await operation();
    await ports.state((state) => {
      state.operations[key] = result;
      for (const expired of Object.keys(state.operations).slice(0, -256))
        delete state.operations[expired];
    });
    return result;
  }
  const catalog = createBackupCatalog(ports);
  const { readVersion, list, remove } = catalog;
  const packages = createBackupPackages(ports, catalog);
  const capture = createBackupCapture(ports, catalog, (kind) => source(ports, kind));
  const service: IBackupLifecycleService = {
    exportBackupArchive: (reference) => mutate(() => packages.exportArchive(reference)),
    importBackupArchive: (text, operationId) =>
      mutate(() => record("import", operationId, () => packages.importArchive(text))),
    async getBackupState() {
      const state = await ports.state((state) => ({
        policy: structuredClone(state.policy),
        nextProviderCheckAt:
          state.nextProviderAt === null ? null : new Date(state.nextProviderAt).toISOString(),
        lastCheckAt: state.lastCheckAt,
        lastResult: state.lastResult,
        error: state.error,
      }));
      const providerItems = ports.sources.providers
        ? (await ports.sources.providers.capture()).items
        : [];
      if (state.lastResult && ports.currentRevision) {
        const results = (
          await Promise.all(
            state.lastResult.results.map(async (result) =>
              result.locationRevision ===
              ports.digest(await ports.currentRevision!(result.location))
                ? result
                : null,
            ),
          )
        ).filter((result): result is NonNullable<typeof result> => result !== null);
        state.lastResult = results.length ? { ...state.lastResult, results } : null;
        if (!results.length) state.error = null;
      }
      return { ...state, running: running || Boolean(await ports.isRunning?.()), providerItems };
    },
    configureBackupPolicy(policy, expectedRevision) {
      policy = backupPolicyInputSchema.parse(policy);
      validateBackupPolicy(policy);
      return mutate(async () => {
        await ports.validatePolicy?.(policy);
        return ports.state((state) => {
          if (state.policy.revision !== expectedRevision)
            throw new Error("Backup policy changed; refresh before saving");
          const next = { ...structuredClone(policy), revision: expectedRevision + 1 };
          if (
            next.providers.enabled &&
            (!state.policy.providers.enabled ||
              next.providers.intervalMinutes !== state.policy.providers.intervalMinutes)
          )
            state.nextProviderAt = ports.now() + next.providers.intervalMinutes * 60_000;
          if (!next.providers.enabled) state.nextProviderAt = null;
          state.policy = next;
          return next;
        });
      });
    },
    backupNow(request) {
      return mutate(() => capture(request));
    },
    async listBackups(location, kind) {
      const versions = await list(await ports.destination(location), kind);
      if (ports.legacy && kind !== "providers")
        versions.push(...(await ports.legacy.list(location)));
      return versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    planBackupRestore(request) {
      request = backupRestoreRequestSchema.parse(request);
      return mutate(async () => {
        if (
          request.locationRevision !==
          ports.digest((await ports.destination(request.location)).revision)
        )
          throw new Error("Backup location changed; reload its versions before restoring");
        let snapshot: BackupSnapshot;
        const legacy = /^legacy-[a-f0-9]{64}$/.test(request.id);
        if (legacy) {
          if (!ports.legacy) throw new Error("Legacy backup recovery is unavailable");
          snapshot = await ports.legacy.read(request);
        } else {
          const destination = await ports.destination(request.location);
          const entry = await readVersion(destination, request.id);
          if (!entry) throw new Error("Backup no longer exists");
          const bytes = await destination.get(`${ROOT}${request.id}/archive.json`);
          if (!bytes || ports.digest(new TextDecoder().decode(bytes)) !== entry.archiveDigest)
            throw new Error("Backup archive is missing or damaged");
          snapshot = (await ports.open(bytes)) as BackupSnapshot;
          if (
            snapshot.kind !== entry.version.kind ||
            snapshot.targetKey !== entry.version.targetKey ||
            ports.digest(canonicalBackupJson(snapshot)) !== entry.fingerprint
          )
            throw new Error("Backup manifest does not match archive");
        }
        const inspected = await source(ports, snapshot.kind).inspect(snapshot, request);
        const planId = ports.id();
        const preview = {
          planId,
          kind: snapshot.kind,
          label: snapshot.label,
          changes: inspected.changes,
          warnings: [
            ...inspected.warnings,
            ...(legacy
              ? [
                  "This legacy AES-CTR backup has no authentication tag; file hashes are not proof against tampering.",
                ]
              : []),
          ],
        };
        // 凭据快照只留 Host 私有内存；公开预览不携带密钥，提交重验 source revision。
        for (const [id, plan] of ports.restorePlans)
          if (plan.expiresAt <= ports.now()) ports.restorePlans.delete(id);
        while (ports.restorePlans.size >= 4)
          ports.restorePlans.delete(ports.restorePlans.keys().next().value!);
        ports.restorePlans.set(planId, {
          expiresAt: ports.now() + 10 * 60_000,
          request: structuredClone(request),
          snapshot,
          revision: inspected.revision,
          preview,
        });
        return preview;
      });
    },
    commitBackupRestore(planId, operationId) {
      return mutate(() =>
        record("restore", operationId, async () => {
          const plan = ports.restorePlans.get(planId);
          if (!plan || plan.expiresAt <= ports.now()) {
            ports.restorePlans.delete(planId);
            throw new Error("Restore preview expired; inspect the backup again");
          }
          const port = source(ports, plan.snapshot.kind);
          if (
            plan.request.locationRevision !==
            ports.digest((await ports.destination(plan.request.location)).revision)
          )
            throw new Error("Backup location changed after restore preview");
          const current = await port.inspect(plan.snapshot, plan.request);
          if (current.revision !== plan.revision)
            throw new Error("Source changed after preview; refresh the restore plan");
          const result = await port.restore(
            plan.snapshot,
            plan.request,
            plan.revision,
            operationId,
          );
          ports.restorePlans.delete(planId);
          return { operationId, ...result } satisfies BackupRestoreResult;
        }),
      );
    },
    async previewBackupCleanup(location, kind): Promise<BackupCleanupPreview> {
      const destination = await ports.destination(location);
      const { count, sourceId } = await ports.state((state) => ({
        count: state.policy.retention[location],
        sourceId: state.sourceId,
      }));
      const versions = retainedBackupCandidates(await list(destination, kind), count, sourceId);
      return { versions, totalBytes: versions.reduce((sum, v) => sum + v.size, 0) };
    },
    deleteBackups(references, operationId) {
      return mutate(() =>
        record("delete", operationId, async () => {
          if (!Array.isArray(references) || references.length > 1000)
            throw new Error("Select at most 1000 backups");
          let deleted = 0;
          const errors: string[] = [];
          for (const reference of references) {
            try {
              if (
                reference.locationRevision !==
                ports.digest((await ports.destination(reference.location)).revision)
              )
                throw new Error("Backup location changed; reload its versions before deleting");
              await remove(await ports.destination(reference.location), reference);
              deleted++;
            } catch (error) {
              errors.push(error instanceof Error ? error.message : "Delete failed");
            }
          }
          return { deleted, errors };
        }),
      );
    },
    exportRecoveryKit: (password) => mutate(() => ports.exportKeys(password)),
    importRecoveryKit: (text, password) => mutate(() => ports.importKeys(text, password)),
  };
  return {
    service,
    capture,
    dispose() {
      ports.restorePlans.clear();
    },
    async resumeDeletes() {
      if (!(await ports.state((state) => Object.keys(state.pendingDeletions ?? {}).length))) return;
      try {
        await mutate(() => catalog.resumeDeletes());
      } catch (error) {
        if ((error as { code?: string }).code !== "BACKUP_BUSY") throw error;
      }
    },
    async tickProviders() {
      const plan = await ports.state((state) => ({
        ...state.policy.providers,
        due: state.nextProviderAt,
      }));
      if (!plan.enabled || (plan.due !== null && plan.due > ports.now())) return;
      try {
        await mutate(async () => {
          const latest = await ports.state((state) => ({
            ...state.policy.providers,
            due: state.nextProviderAt,
          }));
          if (!latest.enabled || (latest.due !== null && latest.due > ports.now())) return;
          try {
            await capture({
              kind: "providers",
              selection: latest.selection ?? undefined,
              locations: latest.locations,
              operationId: ports.id(),
            });
          } finally {
            await ports.state((state) => {
              state.nextProviderAt = state.policy.providers.enabled
                ? ports.now() + state.policy.providers.intervalMinutes * 60_000
                : null;
            });
          }
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "BACKUP_BUSY") throw error;
      }
    },
  };
}
