import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BackupKind,
  BackupLocation,
  BackupPolicy,
  BackupReference,
  BackupRestorePreview,
  BackupRestoreRequest,
  BackupSelection,
  BackupState,
  BackupTarget,
  BackupVersion,
  IGitBackupService,
} from "@lcode/services";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
export function useAutomaticBackup(
  service: IGitBackupService | null,
  kind: BackupKind,
  target?: BackupTarget | null,
) {
  const platform = useOptionalPlatform();
  const [state, setState] = useState<BackupState | null>(null);
  const [draft, setDraft] = useState<BackupPolicy | null>(null);
  const [versions, setVersions] = useState<BackupVersion[]>([]);
  const [location, setLocation] = useState<BackupLocation>("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<BackupRestorePreview | null>(null);
  const epoch = useRef(0);
  const lock = useRef(false);
  const initialized = useRef(false);
  const read = useCallback(
    async (token: number) => {
      if (!service?.getBackupState) throw new Error("Backup lifecycle is unavailable on this Host");
      const next = await service.getBackupState();
      if (epoch.current !== token) return;
      setState(next);
      if (!initialized.current) {
        initialized.current = true;
        setDraft(next.policy);
      }
    },
    [service],
  );
  const run = useCallback(
    async <T>(
      operation: (current: () => boolean) => Promise<T>,
      message?: string,
    ): Promise<T | undefined> => {
      if (!service || lock.current) return;
      lock.current = true;
      const token = epoch.current;
      const current = () => token === epoch.current;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await operation(current);
        if (current()) {
          if (message) setNotice(message);
          try {
            await read(token);
          } catch (cause) {
            setError(
              `Operation completed; refresh failed: ${cause instanceof Error ? cause.message : "unknown"}`,
            );
          }
        }
        return result;
      } catch (cause) {
        if (current()) setError(cause instanceof Error ? cause.message : "Backup operation failed");
      } finally {
        if (current()) {
          lock.current = false;
          setBusy(false);
        }
      }
    },
    [read, service],
  );
  useEffect(() => {
    const token = ++epoch.current;
    lock.current = false;
    initialized.current = false;
    setState(null);
    setDraft(null);
    setVersions([]);
    setPreview(null);
    setBusy(true);
    setError(null);
    void read(token)
      .catch((cause) => {
        if (token === epoch.current)
          setError(cause instanceof Error ? cause.message : "Backup is unavailable");
      })
      .finally(() => {
        if (token === epoch.current) setBusy(false);
      });
    return () => {
      epoch.current++;
    };
  }, [read]);
  const refreshVersions = useCallback(
    () =>
      run(async (current) => {
        if (!service?.listBackups) throw new Error("Backup history is unavailable");
        const next = await service.listBackups(location, kind);
        if (current()) setVersions(next);
      }),
    [kind, location, run, service],
  );
  return {
    state,
    draft,
    setDraft,
    versions,
    location,
    setLocation: (next: BackupLocation) => {
      setLocation(next);
      setVersions([]);
    },
    busy,
    error,
    notice,
    preview,
    setPreview,
    refresh: () =>
      run(async (current) => {
        await read(epoch.current);
        if (current()) setNotice(null);
      }),
    refreshVersions,
    resetPolicy: () =>
      run(async (current) => {
        if (!service?.getBackupState) return;
        const next = await service.getBackupState();
        if (current()) {
          setState(next);
          setDraft(next.policy);
        }
      }),
    save: (nextDraft = draft) =>
      run(async (current) => {
        if (!nextDraft || !service?.configureBackupPolicy) return;
        const { revision, ...policy } = nextDraft;
        const accepted = await service.configureBackupPolicy(policy, revision);
        if (current()) setDraft(accepted);
      }, "settings.backup.saved"),
    backup: (selection?: BackupSelection, backupTarget = target) =>
      run(async (current) => {
        if (!service?.backupNow) throw new Error("Backup is unavailable");
        const result = await service.backupNow({
          kind,
          operationId: crypto.randomUUID(),
          ...(backupTarget ? { target: backupTarget } : {}),
          selection,
          ...(kind === "providers" ? { locations: state?.policy.providers.locations } : {}),
        });
        const failed = result.results.filter((result) => result.status === "failed");
        if (current())
          setNotice(
            result.results.every((result) => result.status === "skipped-unchanged")
              ? "settings.backup.unchanged"
              : "settings.backup.completed",
          );
        if (failed.length)
          throw new Error(failed.map((item) => `${item.location}: ${item.error}`).join("; "));
        if (service.listBackups) {
          const next = await service.listBackups(location, kind);
          if (current()) setVersions(next);
        }
      }),
    plan: (request: BackupRestoreRequest) =>
      run(async (current) => {
        if (!service?.planBackupRestore) throw new Error("Restore is unavailable");
        const next = await service.planBackupRestore(request);
        if (current()) setPreview(next);
        return next;
      }),
    restore: () =>
      run(async (current) => {
        if (!preview || !service?.commitBackupRestore) return;
        const result = await service.commitBackupRestore(preview.planId, crypto.randomUUID());
        if (current()) {
          setPreview(null);
          setNotice(
            result.warnings.length
              ? "settings.backup.restoredWithWarnings"
              : "settings.backup.restored",
          );
        }
        return result;
      }),
    delete: (references: BackupReference[]) =>
      run(async (current) => {
        if (!service?.deleteBackups) return;
        const result = await service.deleteBackups(references, crypto.randomUUID());
        if (service.listBackups) {
          const next = await service.listBackups(location, kind);
          if (current()) setVersions(next);
        }
        if (result.errors.length) throw new Error(result.errors.join("; "));
        return result;
      }, "settings.backup.deleted"),
    cleanup: () =>
      run(async (current) => {
        if (!service?.previewBackupCleanup) throw new Error("Cleanup is unavailable");
        const result = await service.previewBackupCleanup(location, kind);
        if (current() && !result.versions.length) setNotice("settings.backup.noCleanup");
        return result;
      }),
    exportKit: (password: string) =>
      run(async (current) => {
        if (!service?.exportRecoveryKit || !platform?.saveFile)
          throw new Error("Recovery kit export is unavailable");
        const text = await service.exportRecoveryKit(password);
        if (!current()) return;
        const data = new TextEncoder().encode(text);
        try {
          const result = await platform.saveFile({
            data: data.buffer,
            suggestedName: "lcode-recovery-kit.json",
          });
          if (result.canceled) return;
          if (!result.success) throw new Error(result.error || "Export failed");
          if (current()) setNotice("settings.backup.kitExported");
        } finally {
          data.fill(0);
        }
      }),
    importKit: (input: string | File, password: string) =>
      run(async () => {
        if (!service?.importRecoveryKit) throw new Error("Recovery key import is unavailable");
        const text = await readBackupImport(input, 1024 * 1024);
        await service.importRecoveryKit(text, password);
      }, "settings.backup.kitImported"),
    download: (reference: BackupReference) =>
      run(async (current) => {
        if (!service?.exportBackupArchive || !platform?.saveFile)
          throw new Error("Backup export is unavailable");
        const text = await service.exportBackupArchive(reference);
        if (!current()) return;
        const data = new TextEncoder().encode(text);
        try {
          const result = await platform.saveFile({
            data: data.buffer,
            suggestedName: "lcode-backup.json",
          });
          if (!result.success && !result.canceled) throw new Error(result.error || "Export failed");
        } finally {
          data.fill(0);
        }
      }),
    importArchive: (input: string | File) =>
      run(async (current) => {
        if (!service?.importBackupArchive) throw new Error("Backup import is unavailable");
        const text = await readBackupImport(input, 768 * 1024 * 1024);
        await service.importBackupArchive(text, crypto.randomUUID());
        if (service.listBackups) {
          const next = await service.listBackups("local", kind);
          if (current()) {
            setLocation("local");
            setVersions(next);
          }
        }
      }, "settings.backup.archiveImported"),
    chooseDirectory: async () => platform?.selectDirectory(),
  };
}

async function readBackupImport(input: string | File, limit: number): Promise<string> {
  if (typeof input === "string") return input;
  if (input.size > limit) throw new Error("Backup import file exceeds the size limit");
  // 文件读取也属于同一操作，超限或读取失败必须显示失败，不能静默忽略选择。
  return input.text();
}
