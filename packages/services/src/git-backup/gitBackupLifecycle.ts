import { createHash, randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import {
  createBackupCrypto,
  createBackupEngine,
  createBackupStateStore,
  localBackupStore,
  type BackupObjectStore,
  type BackupSourcePort,
} from "../backup/node.js";
import type { BackupLocation, BackupRequest } from "../backup/contract.js";
import { ensureKeyPair } from "./gitBackupEncryption.js";
import { createBackupCloudStore } from "./backupCloudStore.js";
import { createGitBackupSource } from "./gitBackupRestore.js";
import { getGitBackupDestinationLocation, getSelectedGitBackupProviders } from "./gitBackup.js";
import { createLegacyBackupRecovery } from "./legacyBackupRecovery.js";
import type { createBackupStore, GitBackupAdmission } from "./gitBackupStore.js";
import type { GitBackupServiceOptions } from "./gitBackupService.js";
export function createGitBackupLifecycle(
  dataDir: string,
  store: ReturnType<typeof createBackupStore>,
  options: GitBackupServiceOptions,
  executionLock: () => Promise<(() => Promise<void>) | null>,
) {
  const state = createBackupStateStore(dataDir);
  const crypto = createBackupCrypto(dataDir, () => ensureKeyPair(dataDir));
  const git = createGitBackupSource(options);
  function unavailable(location: BackupLocation, error: unknown): BackupObjectStore {
    const reject = async (): Promise<never> => {
      throw new Error(
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Backup destination unavailable",
      );
    };
    return {
      location,
      revision: "unavailable",
      get: reject,
      put: reject,
      remove: reject,
      list: reject,
    };
  }
  async function admittedDestinations(
    admission: GitBackupAdmission,
    explicit = false,
  ): Promise<BackupObjectStore[]> {
    const policy = await state((state) => state.policy);
    return [
      ...(!explicit && policy.localEnabled
        ? [localBackupStore(policy.localDirectory || join(dataDir, "versions"))]
        : []),
      ...admission.destinations.map((destination) =>
        destination.config
          ? createBackupCloudStore(destination.provider, destination.config, options)
          : unavailable(destination.provider, destination.error),
      ),
    ];
  }
  async function destination(location: BackupLocation): Promise<BackupObjectStore> {
    if (!["local", "oss", "minio"].includes(location)) throw new Error("Unknown backup location");
    if (location === "local") {
      const policy = await state((state) => state.policy);
      return localBackupStore(policy.localDirectory || join(dataDir, "versions"));
    }
    const admission = await store.loadAdmission(location);
    const config = admission.destinations[0]?.config;
    if (!config)
      throw new Error(admission.destinations[0]?.error || "Backup destination is not configured");
    return createBackupCloudStore(location, config, options);
  }
  async function destinations(request?: BackupRequest): Promise<BackupObjectStore[]> {
    const policy = await state((state) => state.policy);
    const config = await store.loadConfig();
    const locations = request?.locations ?? [
      ...(policy.localEnabled ? ["local" as const] : []),
      ...getSelectedGitBackupProviders(config),
    ];
    const admission = await store.loadAdmission([
      ...new Set(locations.filter((location): location is "oss" | "minio" => location !== "local")),
    ]);
    return Promise.all(
      [...new Set(locations)].map(async (location) => {
        try {
          if (location === "local" && !policy.localEnabled)
            throw new Error("Local backup is disabled");
          if (location === "local")
            return localBackupStore(policy.localDirectory || join(dataDir, "versions"));
          const cloud = admission.destinations.find((entry) => entry.provider === location);
          if (!cloud?.config)
            throw new Error(cloud?.error || "Backup destination is not configured");
          return createBackupCloudStore(location, cloud.config, options);
        } catch (error) {
          const unavailable = async (): Promise<never> => {
            throw new Error(
              error instanceof Error ? error.message : "Backup destination unavailable",
            );
          };
          return {
            location,
            revision:
              location === "local"
                ? policy.localDirectory || join(dataDir, "versions")
                : getGitBackupDestinationLocation(admission.config[location]),
            get: unavailable,
            put: unavailable,
            remove: unavailable,
            list: unavailable,
          } as BackupObjectStore;
        }
      }),
    );
  }
  const sources: Partial<Record<"git" | "providers", BackupSourcePort>> = { git };
  if (options.providerBackupSource) sources.providers = options.providerBackupSource;
  const legacy = createLegacyBackupRecovery(async (location) => {
    if (location === "local") return null;
    const admission = await store.loadAdmission(location);
    const config = admission.destinations[0]?.config;
    if (!config) throw new Error("Backup destination is not configured");
    return createBackupCloudStore(location, config, options, true);
  }, crypto.openLegacy);
  const engine = createBackupEngine({
    now: options.now ?? Date.now,
    id: randomUUID,
    digest: (value) => createHash("sha256").update(value).digest("hex"),
    state,
    sources,
    destinations,
    destination,
    legacy,
    staging: localBackupStore(join(dataDir, "staging")),
    async currentRevision(location) {
      if (location === "local") {
        const policy = await state((state) => state.policy);
        return localBackupStore(policy.localDirectory || join(dataDir, "versions")).revision;
      }
      return getGitBackupDestinationLocation((await store.loadConfig())[location]);
    },
    async validatePolicy(policy) {
      if (policy.localDirectory !== null && !isAbsolute(policy.localDirectory))
        throw new Error("Local backup directory must be absolute on this Host");
      if (policy.providers.enabled && !sources.providers)
        throw new Error("Provider backup is unavailable on this Host");
      if (policy.providers.enabled)
        for (const location of policy.providers.locations)
          if (location !== "local") await destination(location);
    },
    async isRunning() {
      const release = await executionLock();
      if (!release) return true;
      await release();
      return false;
    },
    async exclusive(operation) {
      const release = await executionLock();
      if (!release)
        throw Object.assign(new Error("A backup operation is already running for this profile"), {
          code: "BACKUP_BUSY",
        });
      try {
        return await operation();
      } finally {
        await release();
      }
    },
    seal: crypto.seal,
    open: crypto.open,
    exportKeys: crypto.exportKeys,
    importKeys: crypto.importKeys,
    restorePlans: new Map(),
  });
  return { ...engine, git, state, admittedDestinations };
}
