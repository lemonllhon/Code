export type BackupKind = "git" | "providers";
export type BackupLocation = "local" | "oss" | "minio";
export interface BackupSelection {
  providerIds?: string[];
  accountIds?: string[];
}
export interface BackupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}
export interface BackupRequest {
  kind: BackupKind;
  target?: BackupTarget;
  selection?: BackupSelection;
  locations?: BackupLocation[];
  operationId: string;
}
export interface BackupPolicy {
  revision: number;
  localEnabled: boolean;
  localDirectory: string | null;
  retention: Record<BackupLocation, number | null>;
  providers: {
    enabled: boolean;
    intervalMinutes: number;
    selection: BackupSelection | null;
    locations: BackupLocation[];
  };
}
export interface BackupItem {
  id: string;
  label: string;
  type: "provider" | "account" | "git";
}
export interface BackupSnapshot {
  kind: BackupKind;
  targetKey: string;
  label: string;
  selection: BackupSelection | null;
  items: BackupItem[];
  data: unknown;
}
export interface BackupVersion {
  locationRevision: string;
  id: string;
  sourceId: string;
  kind: BackupKind;
  targetKey: string;
  scope: string;
  createdAt: string;
  label: string;
  items: BackupItem[];
  size: number;
  location: BackupLocation;
  keyId: string;
  format: 1 | 2;
  rollback?: boolean;
}
export interface BackupResult {
  operationId: string;
  results: {
    location: BackupLocation;
    locationRevision: string;
    status: "created" | "skipped-unchanged" | "failed";
    version?: BackupVersion;
    error?: string;
  }[];
}
export interface BackupState {
  policy: BackupPolicy;
  providerItems: BackupItem[];
  running: boolean;
  lastCheckAt: string | null;
  nextProviderCheckAt: string | null;
  lastResult: BackupResult | null;
  error: string | null;
}
export interface BackupReference {
  locationRevision: string;
  id: string;
  location: BackupLocation;
}
export interface BackupRestoreRequest extends BackupReference {
  selection?: BackupSelection;
  mode: "merge" | "replace";
  destinationPath?: string;
  overwriteConflicts?: boolean;
}
export interface BackupRestorePreview {
  planId: string;
  kind: BackupKind;
  label: string;
  changes: {
    id: string;
    label: string;
    action: "add" | "replace" | "keep" | "delete" | "reauthorize";
  }[];
  warnings: string[];
}
export interface BackupRestoreResult {
  operationId: string;
  restored: number;
  warnings: string[];
}
export interface BackupCleanupPreview {
  versions: BackupVersion[];
  totalBytes: number;
}
export interface IBackupLifecycleService {
  exportBackupArchive(reference: BackupReference): Promise<string>;
  importBackupArchive(text: string, operationId: string): Promise<BackupVersion>;
  getBackupState(): Promise<BackupState>;
  configureBackupPolicy(
    policy: Omit<BackupPolicy, "revision">,
    expectedRevision: number,
  ): Promise<BackupPolicy>;
  backupNow(request: BackupRequest): Promise<BackupResult>;
  listBackups(location: BackupLocation, kind?: BackupKind): Promise<BackupVersion[]>;
  planBackupRestore(request: BackupRestoreRequest): Promise<BackupRestorePreview>;
  commitBackupRestore(planId: string, operationId: string): Promise<BackupRestoreResult>;
  previewBackupCleanup(location: BackupLocation, kind?: BackupKind): Promise<BackupCleanupPreview>;
  deleteBackups(
    references: BackupReference[],
    operationId: string,
  ): Promise<{ deleted: number; errors: string[] }>;
  exportRecoveryKit(password: string): Promise<string>;
  importRecoveryKit(text: string, password: string): Promise<void>;
}
