import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import type { GitOperationScope } from "@/hooks/useGitOperationSession.js";
import { useGitRepositoryAcquisition } from "@/hooks/useGitRepositoryAcquisition.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitOperationResult } from "./GitOperationResult.js";
import { GitOperationRecovery } from "./GitOperationRecovery.js";

export function GitRepositoryImportForm({
  initialDirectory = "",
  onImported,
  onBusyChange,
  ...scope
}: Omit<GitOperationScope, "workspacePath"> & {
  initialDirectory?: string;
  onImported?: (path: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.workspace.${key}` });
  const {
    session,
    confirmation,
    validationError,
    directory,
    setDirectory,
    mode,
    setMode,
    url,
    setUrl,
    targetName,
    setTargetName,
    initialBranch,
    setInitialBranch,
    allowNested,
    setAllowNested,
    browsing,
    setBrowsing,
    browse,
    prepare,
    clearPreview,
    confirm: acquire,
  } = useGitRepositoryAcquisition({ ...scope, initialDirectory, onBusyChange });
  const confirm = async () => {
    const receipt = await acquire();
    if (receipt?.status === "success" && receipt.targetPath) onImported?.(receipt.targetPath);
  };
  return (
    <section className="min-w-0 space-y-2 text-ui-sm" data-testid="git-repository-import">
      <div className="flex flex-wrap gap-1">
        {(["clone", "init"] as const).map((item) => (
          <Button
            key={item}
            type="button"
            size="sm"
            variant={mode === item ? "secondary" : "ghost"}
            disabled={session.pending}
            onClick={() => {
              setMode(item);
              clearPreview();
            }}
          >
            {t(item)}
          </Button>
        ))}
      </div>
      <label className="block text-ui-xs">
        {t(mode === "clone" ? "parentDirectory" : "initDirectory")}
        <div className="mt-1 flex min-w-0 gap-1">
          <Input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            disabled={session.pending}
            aria-label={t("directory")}
            placeholder={t("directory")}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={session.pending}
            onClick={() => {
              void browse();
            }}
          >
            {t("browse")}
          </Button>
        </div>
      </label>
      {browsing ? (
        <div className="h-64 min-w-0 overflow-auto rounded border border-border">
          <DirectoryBrowser
            services={session.services}
            embedded
            onSelect={(path) => {
              setDirectory(path);
              setBrowsing(false);
            }}
            onCancel={() => setBrowsing(false)}
          />
        </div>
      ) : null}
      {mode === "clone" ? (
        <>
          <label className="block text-ui-xs">
            {t("cloneUrl")}
            <Input
              aria-label={t("cloneUrl")}
              value={url}
              disabled={session.pending}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="block text-ui-xs">
            {t("targetName")}
            <Input
              aria-label={t("targetName")}
              value={targetName}
              disabled={session.pending}
              maxLength={100}
              onChange={(event) => setTargetName(event.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <label className="block text-ui-xs">
            {t("initialBranch")}
            <Input
              aria-label={t("initialBranch")}
              value={initialBranch}
              disabled={session.pending}
              onChange={(event) => setInitialBranch(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-ui-xs">
            <input
              type="checkbox"
              checked={allowNested}
              disabled={session.pending}
              onChange={(event) => setAllowNested(event.target.checked)}
              className="size-3.5"
            />
            {t("allowNested")}
          </label>
        </>
      )}
      <p className="text-ui-xs text-foreground-subtle">
        {t(mode === "clone" ? "cloneHint" : "initHint")}
      </p>
      {validationError ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {t("error.invalid-input")}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={session.pending || !session.ready}
          onClick={() => {
            void session.loadReceipt();
          }}
        >
          {t("queryResult")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={session.pending || !session.ready}
          onClick={() => {
            void prepare();
          }}
          data-testid="git-import-preview"
        >
          {t("previewImport")}
        </Button>
      </div>
      {confirmation ? (
        <div
          className="space-y-2 border-y border-border bg-surface px-3 py-2"
          data-testid="git-import-confirmation"
        >
          <p className="font-medium">{t(confirmation.options.mode)}</p>
          <p className="break-all text-ui-xs">{confirmation.preview.targetPath}</p>
          {confirmation.preview.parentRepository ? (
            <p className="break-all text-ui-xs">
              {t("parentRepository")}: {confirmation.preview.parentRepository}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={session.pending}
              onClick={() => clearPreview()}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="git-import-confirm"
              disabled={
                session.pending ||
                (confirmation.options.mode === "init" &&
                  Boolean(confirmation.preview.parentRepository) &&
                  !confirmation.options.allowNested)
              }
              onClick={() => {
                void confirm();
              }}
            >
              {t("confirm")}
            </Button>
          </div>
        </div>
      ) : null}
      <GitOperationResult receipt={session.receipt} error={session.error} />
      {onImported &&
      session.receipt?.status === "success" &&
      ["repository-init", "repository-clone"].includes(session.receipt.kind) &&
      session.receipt.targetPath ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onImported(session.receipt!.targetPath!)}
        >
          {t("useDirectory")}
        </Button>
      ) : null}
      <GitOperationRecovery session={session} operation={session.receipt} />
    </section>
  );
}
