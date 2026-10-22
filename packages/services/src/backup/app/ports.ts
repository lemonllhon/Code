import type {
  BackupLocation,
  BackupPolicy,
  BackupRequest,
  BackupResult,
  BackupRestorePreview,
  BackupRestoreRequest,
  BackupRestoreResult,
  BackupSelection,
  BackupSnapshot,
  BackupTarget,
} from "../contract.js";
/** Host-only ports; snapshots contain credentials and are never an RPC read model. */
export interface BackupSourcePort {
  capture(selection?: BackupSelection, target?: BackupTarget): Promise<BackupSnapshot>;
  inspect(
    snapshot: BackupSnapshot,
    request: BackupRestoreRequest,
  ): Promise<Omit<BackupRestorePreview, "planId" | "kind" | "label"> & { revision: string }>;
  restore(
    snapshot: BackupSnapshot,
    request: BackupRestoreRequest,
    revision: string,
    operationId: string,
  ): Promise<Omit<BackupRestoreResult, "operationId">>;
}
export interface BackupObjectStore {
  location: BackupLocation;
  revision: string;
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  exists?(key: string): Promise<boolean>;
}
export interface BackupCheckpoint {
  fingerprint: string;
  id: string;
}
export interface StoredRestorePlan {
  expiresAt: number;
  request: BackupRestoreRequest;
  snapshot: BackupSnapshot;
  revision: string;
  preview: BackupRestorePreview;
}
export interface BackupEngineState {
  version: 1;
  sourceId: string;
  policy: BackupPolicy;
  nextProviderAt: number | null;
  lastCheckAt: string | null;
  lastResult: BackupResult | null;
  error: string | null;
  checkpoints: Record<string, BackupCheckpoint>;
  operations: Record<string, unknown>;
  pendingDeletions?: Record<
    string,
    { id: string; location: BackupLocation; locationRevision: string; revision: string }
  >;
  pendingCaptures?: Record<string, { id: string; createdAt: string }>;
}
export interface BackupEnginePorts {
  now(): number;
  isRunning?(): Promise<boolean>;
  currentRevision?(location: BackupLocation): Promise<string>;
  validatePolicy?(policy: Omit<BackupPolicy, "revision">): Promise<void>;
  id(): string;
  digest(value: string): string;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  state<T>(operation: (state: BackupEngineState) => T | Promise<T>): Promise<T>;
  sources: Partial<Record<BackupSnapshot["kind"], BackupSourcePort>>;
  destinations(request?: BackupRequest): Promise<BackupObjectStore[]>;
  destination(location: BackupObjectStore["location"]): Promise<BackupObjectStore>;
  seal(value: unknown): Promise<{ bytes: Uint8Array; keyId: string }>;
  open(bytes: Uint8Array): Promise<unknown>;
  exportKeys(password: string): Promise<string>;
  importKeys(text: string, password: string): Promise<void>;
  restorePlans: Map<string, StoredRestorePlan>;
  staging?: BackupObjectStore;
  legacy?: {
    list(location: BackupLocation): Promise<import("../contract.js").BackupVersion[]>;
    read(reference: import("../contract.js").BackupReference): Promise<BackupSnapshot>;
    remove(reference: import("../contract.js").BackupReference): Promise<void>;
  };
}
