import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  BackupReference,
  BackupLocation,
  BackupSnapshot,
  BackupVersion,
} from "../backup/contract.js";
import type { BackupObjectStore } from "../backup/node.js";
import { unpackGitBackup } from "./gitBackupRestore.js";
const manifestSchema = z.object({
  version: z.literal("repo_backup_manifest/v1"),
  workspacePath: z.string(),
  workspaceIdentity: z.string().optional(),
  createdAt: z.string().datetime(),
  totalFiles: z.number().int().nonnegative().max(100_000),
  totalSize: z
    .number()
    .int()
    .nonnegative()
    .max(256 * 1024 * 1024),
  entries: z
    .array(
      z.object({
        path: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.number().optional(),
      }),
    )
    .max(100_000),
});
const isManifest = (key: string) =>
  /^[a-f0-9]{24}\/backup-[A-Za-z0-9.-]+-[a-f0-9]{16}\/manifest\.json$/.test(key);
const idOf = (key: string) => `legacy-${createHash("sha256").update(key).digest("hex")}`;
export function createLegacyBackupRecovery(
  store: (location: BackupLocation) => Promise<BackupObjectStore | null>,
  decrypt: (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => Promise<Uint8Array>,
) {
  async function entries(location: BackupLocation) {
    const destination = await store(location);
    if (!destination) return [];
    const keys = (await destination.list("")).filter(isManifest);
    const results = [];
    for (const key of keys) {
      const base = key.slice(0, -"manifest.json".length);
      if (await destination.get(`${base}tombstone.deleted`)) continue;
      const bytes = await destination.get(key);
      if (!bytes) continue;
      const manifest = manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
      const version: BackupVersion = {
        id: idOf(key),
        sourceId: "legacy",
        kind: "git",
        targetKey: manifest.workspaceIdentity?.trim() || manifest.workspacePath,
        scope: "all",
        createdAt: manifest.createdAt,
        label: manifest.workspacePath,
        items: [
          {
            id: manifest.workspaceIdentity || manifest.workspacePath,
            label: manifest.workspacePath,
            type: "git",
          },
        ],
        size: manifest.totalSize,
        location,
        locationRevision: createHash("sha256").update(destination.revision).digest("hex"),
        keyId: "legacy",
        format: 1,
      };
      results.push({ key, base, manifest, version, destination });
    }
    return results;
  }
  async function find(reference: BackupReference) {
    return (await entries(reference.location)).find((entry) => entry.version.id === reference.id);
  }
  return {
    async list(location: BackupLocation) {
      return (await entries(location)).map((entry) => entry.version);
    },
    async read(reference: BackupReference): Promise<BackupSnapshot> {
      const entry = await find(reference);
      if (!entry) throw new Error("Legacy backup no longer exists");
      if (entry.version.locationRevision !== reference.locationRevision)
        throw new Error("Backup location changed; reload legacy versions");
      const [key, iv, data] = await Promise.all(
        ["key.enc", "iv.bin", "data.enc"].map((name) =>
          entry.destination.get(`${entry.base}${name}`),
        ),
      );
      if (!key || !iv || !data || data.length > 256 * 1024 * 1024)
        throw new Error("Legacy backup payload is missing or too large");
      const packed = await decrypt(key, iv, data);
      const restored = unpackGitBackup(Buffer.from(packed));
      if (
        restored.length !== entry.manifest.entries.length ||
        restored.length !== entry.manifest.totalFiles
      )
        throw new Error("Legacy backup file count mismatch");
      const files = restored.map((file, index) => {
        const expected = entry.manifest.entries[index]!;
        if (
          file.path !== expected.path ||
          file.content.length !== expected.size ||
          createHash("sha256").update(file.content).digest("hex") !== expected.sha256
        )
          throw new Error("Legacy backup hash mismatch");
        return { ...expected, content: file.content.toString("base64") };
      });
      return {
        kind: "git",
        targetKey: entry.version.targetKey,
        label: entry.version.label,
        selection: null,
        items: entry.version.items,
        data: {
          version: 1,
          target: {
            workspacePath: entry.manifest.workspacePath,
            workspaceIdentity: entry.manifest.workspaceIdentity,
          },
          files,
        },
      };
    },
    async remove(reference: BackupReference) {
      const destination = await store(reference.location);
      if (!destination) throw new Error("Legacy backup location is unavailable");
      if (
        createHash("sha256").update(destination.revision).digest("hex") !==
        reference.locationRevision
      )
        throw new Error("Backup location changed; reload legacy versions");
      // 旧 manifest 删除后仍以严格命名的 tombstone 定位副本，重试不能因列表过滤而遗留密文。
      const manifest = (await destination.list(""))
        .map((key) => key.replace(/tombstone\.deleted$/, "manifest.json"))
        .find((key) => isManifest(key) && idOf(key) === reference.id);
      if (!manifest) return;
      const base = manifest.slice(0, -"manifest.json".length);
      await destination.put(`${base}tombstone.deleted`, Buffer.from("deleted"));
      for (const name of ["manifest.json", "data.enc", "key.enc", "iv.bin"])
        await destination.remove(`${base}${name}`);
    },
  };
}
