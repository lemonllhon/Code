import type { BackupPolicy, BackupSelection, BackupVersion } from "../contract.js";

export function canonicalBackupJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBackupJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalBackupJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function backupSelectionKey(selection?: BackupSelection | null): string {
  if (!selection) return "all";
  return canonicalBackupJson({
    ...(selection.providerIds ? { providerIds: [...new Set(selection.providerIds)].sort() } : {}),
    ...(selection.accountIds ? { accountIds: [...new Set(selection.accountIds)].sort() } : {}),
  });
}
export function retainedBackupCandidates(
  versions: BackupVersion[],
  count: number | null,
  sourceId: string,
): BackupVersion[] {
  if (count === null) return [];
  const groups = new Map<string, BackupVersion[]>();
  for (const version of versions) {
    if (version.sourceId !== sourceId || version.rollback) continue;
    const key = canonicalBackupJson([
      version.kind,
      version.targetKey,
      version.scope,
      version.location,
    ]);
    const group = groups.get(key) ?? [];
    group.push(version);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) =>
    group
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(count),
  );
}
export function validateBackupPolicy(policy: Omit<BackupPolicy, "revision">): void {
  if (
    typeof policy.localEnabled !== "boolean" ||
    (policy.localDirectory !== null && typeof policy.localDirectory !== "string")
  )
    throw new Error("Invalid local backup policy");
  for (const location of ["local", "oss", "minio"] as const) {
    const count = policy.retention[location];
    if (count !== null && (!Number.isInteger(count) || count < 1 || count > 100))
      throw new Error("Keep between 1 and 100 versions, or disable cleanup");
  }
  const p = policy.providers;
  if (p.enabled && p.locations.includes("local") && !policy.localEnabled)
    throw new Error("Enable the local backup location before using it in an automatic plan");
  if (
    typeof p.enabled !== "boolean" ||
    !Number.isInteger(p.intervalMinutes) ||
    p.intervalMinutes < 5 ||
    p.intervalMinutes > 1440
  )
    throw new Error("Backup interval must be between 5 and 1440 minutes");
  if (
    !Array.isArray(p.locations) ||
    p.locations.some((x) => !["local", "oss", "minio"].includes(x)) ||
    (p.enabled && !p.locations.length)
  )
    throw new Error("Select at least one backup location");
  if (p.selection && ![p.selection.providerIds, p.selection.accountIds].some((ids) => ids?.length))
    throw new Error("Backup selection is empty");
}
