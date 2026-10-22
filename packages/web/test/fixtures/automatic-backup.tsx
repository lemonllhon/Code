import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  BackupPolicy,
  BackupSnapshot,
  BackupState,
  BackupVersion,
  IBackupLifecycleService,
} from "@lcode/services";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { AutomaticBackupSettingsView } from "@/settings/AutomaticBackupSection.js";
import { fixture, platform, workspace } from "./git-backup-service.js";
import "@lcode/ui/styles.css";
let generation = 0;
let restored = 0;
const items: BackupSnapshot["items"] = [
  { id: "provider-one", label: "Fixture One", type: "provider" },
  { id: "provider-two", label: "Fixture Two", type: "provider" },
];
let policy: BackupPolicy = {
  revision: 0,
  localEnabled: true,
  localDirectory: null,
  retention: { local: 10, oss: 10, minio: 10 },
  providers: { enabled: false, intervalMinutes: 30, selection: null, locations: ["local"] },
};
let versions: BackupVersion[] = [];
let previous = "";
let lastResult: BackupState["lastResult"] = null;
const lifecycle: IBackupLifecycleService = {
  exportBackupArchive: async () => "fixture-encrypted-archive",
  importBackupArchive: async () => {
    if (!versions[0]) throw new Error("fixture has no package");
    return versions[0];
  },
  getBackupState: async () => ({
    policy,
    providerItems: items,
    running: false,
    lastCheckAt: null,
    nextProviderCheckAt: null,
    lastResult,
    error: null,
  }),
  configureBackupPolicy: async (next, revision) => {
    if (revision !== policy.revision) throw new Error("stale policy");
    policy = { ...next, revision: revision + 1 };
    return policy;
  },
  backupNow: async (request) => {
    const value = JSON.stringify([request.kind, request.selection, generation]);
    const version: BackupVersion = {
      id: crypto.randomUUID(),
      sourceId: "fixture-computer",
      kind: request.kind,
      targetKey: "fixture",
      scope: request.selection ? "selected" : "all",
      createdAt: new Date().toISOString(),
      label: "Fixture backup",
      items: request.selection?.providerIds
        ? items.filter((item) => request.selection?.providerIds?.includes(item.id))
        : items,
      size: 1024,
      location: "local",
      locationRevision: "fixture",
      keyId: "fixture",
      format: 2,
    };
    const unchanged = value === previous;
    previous = value;
    if (!unchanged) versions.unshift(version);
    return (lastResult = {
      operationId: request.operationId,
      results: [
        {
          location: "local",
          locationRevision: "fixture",
          status: unchanged ? "skipped-unchanged" : "created",
          version,
        },
      ],
    });
  },
  listBackups: async (location, kind) =>
    versions.filter((version) => version.location === location && (!kind || version.kind === kind)),
  planBackupRestore: async (request) => ({
    planId: request.id,
    kind: "providers",
    label: "Fixture",
    changes: [{ id: "provider-one", label: "Fixture One", action: "replace" }],
    warnings: [],
  }),
  commitBackupRestore: async (_planId, operationId) => {
    restored++;
    document.getElementById("restored-count")!.textContent = String(restored);
    return { operationId, restored: 1, warnings: [] };
  },
  previewBackupCleanup: async () => ({
    versions: versions.slice(policy.retention.local ?? versions.length),
    totalBytes: 0,
  }),
  deleteBackups: async (refs) => {
    versions = versions.filter(
      (version) => !refs.some((ref) => ref.id === version.id && ref.location === version.location),
    );
    return { deleted: refs.length, errors: [] };
  },
  exportRecoveryKit: async () => "fixture-encrypted-kit",
  importRecoveryKit: async () => {},
};
const service = Object.assign(fixture.service, lifecycle);
function App() {
  const [locale, setLocale] = useState<"zh-CN" | "en-US">("zh-CN");
  return (
    <PlatformProvider platform={platform}>
      <LCodeIntlProvider key={locale} initialLocale={locale}>
        <main className="mx-auto min-w-0 max-w-4xl bg-background p-4 text-ui-base text-foreground">
          <label>
            Language
            <select
              aria-label="Language"
              value={locale}
              onChange={(event) => setLocale(event.target.value as typeof locale)}
            >
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
            </select>
          </label>
          <button
            onClick={() => {
              generation++;
            }}
          >
            Change source
          </button>
          <output id="restored-count">0</output>
          <AutomaticBackupSettingsView
            providerService={service}
            route={{
              service,
              target: workspace,
              connectionKind: "local-ready",
              controllerKey: "fixture",
              workspaceCandidates: [workspace],
            }}
          />
        </main>
      </LCodeIntlProvider>
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
