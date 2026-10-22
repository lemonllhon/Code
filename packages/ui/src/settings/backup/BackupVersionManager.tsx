import { useState } from "react";
import type {
  BackupKind,
  BackupLocation,
  BackupReference,
  BackupRestoreRequest,
  BackupVersion,
} from "@lcode/services";
import type { useAutomaticBackup } from "@/hooks/useAutomaticBackup.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
type BackupController = ReturnType<typeof useAutomaticBackup>;
export function BackupVersionManager({
  backup,
  kind,
}: {
  backup: BackupController;
  kind: BackupKind;
}) {
  const { intl, locale } = useLCodeIntl();
  const text = (id: string) => intl.formatMessage({ id: `settings.backup.${id}` });
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [deletion, setDeletion] = useState<BackupReference[] | null>(null);
  const [restore, setRestore] = useState<BackupVersion | null>(null);
  const [restoreIds, setRestoreIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [overwrite, setOverwrite] = useState(false);
  const [destination, setDestination] = useState("");
  const filtered = backup.versions.filter((version) =>
    `${version.label} ${version.sourceId} ${version.createdAt} ${version.items.map((item) => item.label).join(" ")}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const preview = () => {
    if (!restore) return;
    const request: BackupRestoreRequest = {
      id: restore.id,
      location: restore.location,
      locationRevision: restore.locationRevision,
      mode,
      overwriteConflicts: overwrite,
      ...(kind === "git" ? { destinationPath: destination } : {}),
      ...(restoreIds.length
        ? {
            selection: {
              providerIds: restoreIds.filter((id) =>
                restore.items.some((item) => item.id === id && item.type === "provider"),
              ),
              accountIds: restoreIds.filter((id) =>
                restore.items.some((item) => item.id === id && item.type === "account"),
              ),
            },
          }
        : {}),
    };
    void backup.plan(request).then((result) => {
      if (result) setRestore(null);
    });
  };
  return (
    <section className="min-w-0 space-y-3 border-t border-border pt-4" data-testid="backup-history">
      <h3 className="text-ui-base font-medium">{text("history")}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-ui-caption">
          {text("location")}
          <select
            className="ml-2 rounded border border-input-border bg-input p-1 text-ui-base"
            value={backup.location}
            onChange={(event) => {
              backup.setLocation(event.target.value as BackupLocation);
              setSelected([]);
            }}
            disabled={backup.busy}
          >
            {(["local", "oss", "minio"] as const).map((location) => (
              <option key={location} value={location}>
                {location === "local" ? text("local") : location === "oss" ? "OSS" : "MinIO"}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={backup.busy}
          onClick={() => void backup.refreshVersions()}
        >
          {text("loadHistory")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={backup.busy}
          onClick={() =>
            void backup.cleanup().then((preview) => {
              if (preview?.versions.length)
                setDeletion(
                  preview.versions.map((version) => ({
                    id: version.id,
                    location: version.location,
                    locationRevision: version.locationRevision,
                  })),
                );
            })
          }
        >
          {text("previewCleanup")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={backup.busy || !selected.length}
          onClick={() =>
            setDeletion(
              backup.versions
                .filter((version) => selected.includes(version.id))
                .map((version) => ({
                  id: version.id,
                  location: version.location,
                  locationRevision: version.locationRevision,
                })),
            )
          }
        >
          {text("deleteSelected")}
        </Button>
      </div>
      <Input
        aria-label={text("searchHistory")}
        placeholder={text("searchHistory")}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <label className="block text-ui-caption">
        {text("importArchive")}
        <input
          type="file"
          accept=".json"
          aria-label={text("importArchive")}
          className="block max-w-full text-ui-sm"
          disabled={backup.busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void backup.importArchive(file);
          }}
        />
      </label>
      {!filtered.length ? (
        <p className="text-ui-caption text-foreground-subtle">{text("emptyHistory")}</p>
      ) : (
        <div className="max-h-96 space-y-2 overflow-auto">
          {filtered.map((version) => (
            <div
              key={version.id}
              className="flex min-w-0 flex-wrap items-center gap-2 rounded border border-border p-3"
              data-testid="backup-version"
            >
              <Checkbox
                aria-label={`${text("selectVersion")} ${version.createdAt}`}
                checked={selected.includes(version.id)}
                disabled={backup.busy}
                onCheckedChange={(checked) =>
                  setSelected((previous) =>
                    checked
                      ? [...previous, version.id]
                      : previous.filter((id) => id !== version.id),
                  )
                }
              />
              <div className="min-w-0 flex-1">
                <p className="break-words text-ui-base">{version.label}</p>
                <p className="text-ui-caption text-foreground-subtle">
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(version.createdAt))}{" "}
                  · {version.scope === "all" ? text("full") : text("partial")} ·{" "}
                  {version.items.length} · {Math.ceil(version.size / 1024)} KB · v{version.format}
                </p>
                <p className="truncate font-mono text-ui-xs text-foreground-subtlest">
                  {version.sourceId}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={backup.busy || version.format === 1}
                onClick={() =>
                  void backup.download({
                    id: version.id,
                    location: version.location,
                    locationRevision: version.locationRevision,
                  })
                }
              >
                {text("download")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={backup.busy}
                onClick={() => {
                  setRestore(version);
                  setRestoreIds([]);
                  setMode("merge");
                  setOverwrite(false);
                  setDestination("");
                }}
              >
                {text("restore")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={backup.busy}
                onClick={() =>
                  setDeletion([
                    {
                      id: version.id,
                      location: version.location,
                      locationRevision: version.locationRevision,
                    },
                  ])
                }
              >
                {text("delete")}
              </Button>
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={Boolean(restore)}
        onOpenChange={(open) => {
          if (!open) setRestore(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{text("restore")}</DialogTitle>
            <DialogDescription>{text("restoreNote")}</DialogDescription>
          </DialogHeader>
          {kind === "git" ? (
            <label className="space-y-1 text-ui-caption">
              {text("restoreDirectory")}
              <Input value={destination} onChange={(event) => setDestination(event.target.value)} />
            </label>
          ) : (
            <>
              <label className="flex items-center gap-2 text-ui-base">
                {text("restoreMode")}
                <select
                  className="rounded border border-input-border bg-input p-1"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as typeof mode)}
                >
                  <option value="merge">{text("merge")}</option>
                  <option value="replace">{text("replace")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-ui-base">
                <Checkbox
                  checked={overwrite}
                  onCheckedChange={(value) => setOverwrite(Boolean(value))}
                />
                {text("overwrite")}
              </label>
              <p className="text-ui-caption">{text("restoreSelectionNote")}</p>
              <div className="max-h-56 space-y-2 overflow-auto">
                {restore?.items.map((item) => (
                  <label
                    key={`${item.type}:${item.id}`}
                    className="flex items-center gap-2 text-ui-base"
                  >
                    <Checkbox
                      checked={restoreIds.includes(item.id)}
                      onCheckedChange={(checked) =>
                        setRestoreIds((previous) =>
                          checked
                            ? [...previous, item.id]
                            : previous.filter((id) => id !== item.id),
                        )
                      }
                    />
                    {item.label}
                  </label>
                ))}
              </div>
            </>
          )}
          {backup.error ? (
            <p role="alert" className="text-ui-caption text-destructive">
              {backup.error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestore(null)}>
              {text("cancel")}
            </Button>
            <Button disabled={backup.busy || (kind === "git" && !destination)} onClick={preview}>
              {text("previewRestore")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(backup.preview)}
        onOpenChange={(open) => {
          if (!open) backup.setPreview(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{text("confirmRestore")}</DialogTitle>
            <DialogDescription>{text("confirmRestoreNote")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-2 overflow-auto text-ui-base">
            {backup.preview?.changes.map((change) => (
              <li key={`${change.id}:${change.action}`} className="break-words">
                {text(`action.${change.action}`)} · {change.label}
              </li>
            ))}
          </ul>
          {backup.preview?.warnings.map((warning) => (
            <p key={warning} className="break-words text-ui-caption text-warning">
              {warning}
            </p>
          ))}
          {backup.error ? (
            <p role="alert" className="text-ui-caption text-destructive">
              {backup.error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={backup.busy}
              onClick={() => backup.setPreview(null)}
            >
              {text("cancel")}
            </Button>
            <Button disabled={backup.busy} onClick={() => void backup.restore()}>
              {text("confirmRestore")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deletion)}
        onOpenChange={(open) => {
          if (!open) setDeletion(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{text("confirmDelete")}</DialogTitle>
            <DialogDescription>
              {intl.formatMessage(
                { id: "settings.backup.confirmDeleteNote" },
                { count: deletion?.length ?? 0, location: backup.location },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={backup.busy} onClick={() => setDeletion(null)}>
              {text("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={backup.busy}
              onClick={() => {
                if (deletion)
                  void backup.delete(deletion).then(() => {
                    setDeletion(null);
                    setSelected([]);
                  });
              }}
            >
              {text("confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
