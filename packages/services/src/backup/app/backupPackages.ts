import { z } from "zod";
import type { BackupReference, BackupSnapshot } from "../contract.js";
import type { BackupEnginePorts } from "./ports.js";
import type { createBackupCatalog } from "./backupCatalog.js";
import { backupMarkerSchema } from "../domain/backupSchemas.js";
import { canonicalBackupJson } from "../domain/backupRules.js";
const ROOT = "lcode-backup/v2/";
const packageSchema = z
  .object({
    version: z.literal("lcode-backup-package/v2"),
    manifest: z.string().max(32 * 1024 * 1024),
    archive: z.string().max(768 * 1024 * 1024),
  })
  .strict();
export function createBackupPackages(
  ports: BackupEnginePorts,
  catalog: ReturnType<typeof createBackupCatalog>,
) {
  return {
    async exportArchive(reference: BackupReference) {
      const destination = await ports.destination(reference.location);
      const entry = await catalog.readVersion(destination, reference.id);
      if (reference.locationRevision !== ports.digest(destination.revision))
        throw new Error("Backup location changed; reload its versions before downloading");
      if (!entry) throw new Error("Backup no longer exists");
      const [marker, archive] = await Promise.all([
        destination.get(`${ROOT}${reference.id}/manifest.json`),
        destination.get(`${ROOT}${reference.id}/archive.json`),
      ]);
      if (
        !marker ||
        !archive ||
        ports.digest(new TextDecoder().decode(archive)) !== entry.archiveDigest
      )
        throw new Error("Backup archive is missing or damaged");
      return JSON.stringify({
        version: "lcode-backup-package/v2",
        manifest: new TextDecoder().decode(marker),
        archive: new TextDecoder().decode(archive),
      });
    },
    async importArchive(text: string) {
      if (text.length > 800 * 1024 * 1024)
        throw new Error("Backup package exceeds the import limit");
      const bundle = packageSchema.parse(JSON.parse(text));
      const marker = new TextEncoder().encode(bundle.manifest);
      const archive = new TextEncoder().encode(bundle.archive);
      const entry = backupMarkerSchema.parse(await ports.open(marker));
      if (
        !/^[A-Za-z0-9_-]+\/(git|providers)\/[a-f0-9]{24}\/[A-Za-z0-9_-]+$/.test(entry.version.id) ||
        ports.digest(bundle.archive) !== entry.archiveDigest
      )
        throw new Error("Invalid backup package");
      const snapshot = (await ports.open(archive)) as BackupSnapshot;
      if (
        snapshot.kind !== entry.version.kind ||
        snapshot.targetKey !== entry.version.targetKey ||
        ports.digest(canonicalBackupJson(snapshot)) !== entry.fingerprint
      )
        throw new Error("Backup package manifest mismatch");
      const destination = await ports.destination("local");
      const existing = await catalog.readVersion(destination, entry.version.id);
      if (existing) {
        if (existing.archiveDigest !== entry.archiveDigest)
          throw new Error("Backup package identity conflicts with an existing version");
        return existing.version;
      }
      await destination.put(`${ROOT}${entry.version.id}/archive.json`, archive);
      await destination.remove(`${ROOT}${entry.version.id}/tombstone.deleted`);
      await destination.put(`${ROOT}${entry.version.id}/manifest.json`, marker);
      return {
        ...entry.version,
        location: "local" as const,
        locationRevision: ports.digest(destination.revision),
      };
    },
  };
}
