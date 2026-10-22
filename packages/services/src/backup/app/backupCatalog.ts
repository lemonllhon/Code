import type { BackupKind, BackupReference, BackupVersion } from "../contract.js";
import type { BackupEnginePorts, BackupObjectStore } from "./ports.js";
import { retainedBackupCandidates } from "../domain/backupRules.js";
import { backupMarkerSchema } from "../domain/backupSchemas.js";
const ROOT = "lcode-backup/v2/";
function validateId(id: string) {
  if (!/^[A-Za-z0-9_-]+\/(git|providers)\/[a-f0-9]{24}\/[A-Za-z0-9_-]+$/.test(id))
    throw new Error("Invalid backup reference");
}
export function createBackupCatalog(ports: BackupEnginePorts) {
  async function readVersion(destination: BackupObjectStore, id: string) {
    validateId(id);
    if (await destination.get(`${ROOT}${id}/tombstone.deleted`)) return null;
    const marker = await destination.get(`${ROOT}${id}/manifest.json`);
    if (!marker) return null;
    const opened = backupMarkerSchema.parse(await ports.open(marker));
    if (
      !opened ||
      opened.version?.id !== id ||
      opened.version.format !== 2 ||
      !["git", "providers"].includes(opened.version.kind) ||
      !Array.isArray(opened.version.items) ||
      typeof opened.fingerprint !== "string" ||
      typeof opened.archiveDigest !== "string"
    )
      throw new Error("Invalid backup completion manifest");
    return {
      ...opened,
      version: {
        ...opened.version,
        location: destination.location,
        locationRevision: ports.digest(destination.revision),
      },
    };
  }
  async function list(destination: BackupObjectStore, kind?: BackupKind) {
    const keys = await destination.list(ROOT);
    const versions: BackupVersion[] = [];
    for (const key of keys.filter((key) => key.endsWith("/manifest.json"))) {
      const id = key.slice(ROOT.length, -"/manifest.json".length);
      const entry = await readVersion(destination, id);
      if (entry && (!kind || entry.version.kind === kind)) versions.push(entry.version);
    }
    return versions.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }
  async function remove(destination: BackupObjectStore, reference: BackupReference) {
    if (reference.locationRevision !== ports.digest(destination.revision))
      throw new Error("Backup location changed; reload its versions before deleting");
    const intentKey = ports.digest(
      `${destination.location}:${destination.revision}:${reference.id}`,
    );
    if (/^legacy-[a-f0-9]{64}$/.test(reference.id) && ports.legacy) {
      await ports.state((state) => {
        state.pendingDeletions ??= {};
        state.pendingDeletions[intentKey] = { ...reference, revision: destination.revision };
      });
      await ports.legacy.remove(reference);
      await ports.state((state) => {
        delete state.pendingDeletions?.[intentKey];
      });
      return;
    }
    validateId(reference.id);
    const entry = await readVersion(destination, reference.id);
    // 删除意图先于对象删除；重启后即使 manifest 已删也只能删除这两个固定对象。
    const tombstone = `${ROOT}${reference.id}/tombstone.deleted`;
    const previous = await destination.get(tombstone);
    if (!entry && !previous) {
      await ports.state((state) => {
        delete state.pendingDeletions?.[intentKey];
      });
      return;
    }
    if (previous) {
      const intent = (await ports.open(previous)) as { type?: string; id?: string };
      if (intent.type !== "backup-deletion/v1" || intent.id !== reference.id)
        throw new Error("Invalid backup deletion intent");
    }
    await ports.state((state) => {
      state.pendingDeletions ??= {};
      state.pendingDeletions[intentKey] = { ...reference, revision: destination.revision };
    });
    if (!previous)
      await destination.put(
        tombstone,
        (await ports.seal({ type: "backup-deletion/v1", id: reference.id })).bytes,
      );
    await destination.remove(`${ROOT}${reference.id}/manifest.json`);
    await destination.remove(`${ROOT}${reference.id}/archive.json`);
    await ports.state((state) => {
      for (const [key, value] of Object.entries(state.checkpoints))
        if (value.id === reference.id && key.includes(`:${destination.location}:`))
          delete state.checkpoints[key];
      delete state.pendingDeletions?.[intentKey];
    });
    // tombstone 保留为删除完成事实，避免跨电脑的晚到目录读取复活旧版本。
  }
  async function cleanup(destination: BackupObjectStore) {
    const { count, sourceId } = await ports.state((state) => ({
      count: state.policy.retention[destination.location],
      sourceId: state.sourceId,
    }));
    const candidates = retainedBackupCandidates(await list(destination), count, sourceId);
    for (const candidate of candidates) await remove(destination, candidate);
  }
  async function resumeDeletes() {
    const pending = await ports.state((state) => Object.values(state.pendingDeletions ?? {}));
    let failed = 0;
    for (const reference of pending) {
      try {
        const destination = await ports.destination(reference.location);
        if (destination.revision !== reference.revision) continue;
        await remove(destination, reference);
      } catch {
        failed++;
      }
    }
    if (failed) throw new Error(`${failed} backup deletion(s) could not resume`);
  }
  return { readVersion, list, remove, cleanup, resumeDeletes };
}
