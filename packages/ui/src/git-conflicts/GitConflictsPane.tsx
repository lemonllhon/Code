import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { GitOperationScope } from "@/hooks/useGitOperationSession.js";
import { useGitConflicts } from "@/hooks/useGitConflicts.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitOperationResult } from "@/git-workspace/GitOperationResult.js";
import { GitOperationRecovery } from "@/git-workspace/GitOperationRecovery.js";
import { GitConflictThreeWay } from "./GitConflictThreeWay.js";

export function GitConflictsPane({
  onIntegrate,
  ...props
}: GitOperationScope & { onIntegrate?: () => void }) {
  const c = useGitConflicts(props),
    { session, snapshot, file } = c;
  const { intl } = useLCodeIntl(),
    t = (key: string) => intl.formatMessage({ id: `git.conflict.${key}` });
  const [nativeChecked, setNativeChecked] = useState(false),
    [specialChecked, setSpecialChecked] = useState(false);
  const available = session.ready && !session.pending && !snapshot?.blocked;
  const writable = available && Boolean(snapshot?.sourceRequestId);
  const prepare = (kind: "begin" | "save" | "delete" | "mark") => {
    setNativeChecked(false);
    setSpecialChecked(false);
    c.prepare(kind);
  };
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-ui-sm text-foreground"
      data-testid="git-conflicts-pane"
    >
      <header className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex-1 font-medium">
          {t("title")}{" "}
          <span className="font-normal text-foreground-subtle">
            {snapshot?.files.length ?? "—"}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("refresh")}
          aria-label={t("refresh")}
          disabled={!session.ready || session.pending}
          onClick={c.refresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {snapshot ? (
          <p className="break-all border-b border-border px-3 py-2 text-ui-xs text-foreground-subtle">
            {t(`operation.${snapshot.operation}`)} · {snapshot.root}
          </p>
        ) : null}
        {snapshot?.blocked ? (
          <p className="px-3 py-2 text-ui-xs text-warning">{t("blocked")}</p>
        ) : null}
        {c.staleDraft ? (
          <p className="px-3 py-2 text-ui-xs text-warning" role="alert">
            {t("staleDraft")}
          </p>
        ) : null}
        {file?.hasMarkers ? (
          <p className="px-3 py-2 text-ui-xs text-warning">{t("markersRemain")}</p>
        ) : null}
        <GitOperationResult receipt={session.receipt} error={session.error} />
        {c.navigation ? (
          <div
            className="space-y-2 border-b border-border bg-surface px-3 py-2"
            data-testid="git-conflict-draft-guard"
          >
            <p>{t("draftGuard")}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={c.keepDraft}>
                {t("keepDraft")}
              </Button>
              <Button size="sm" variant="destructive" onClick={c.discardAndNavigate}>
                {t("discardDraft")}
              </Button>
            </div>
          </div>
        ) : null}
        {!snapshot?.sourceRequestId && snapshot?.files.length ? (
          <div className="space-y-2 border-b border-border px-3 py-2">
            <p className="text-ui-xs text-foreground-subtle">{t("beginHint")}</p>
            <Button
              size="sm"
              variant="outline"
              data-testid="git-conflict-begin"
              disabled={!available}
              onClick={() => prepare("begin")}
            >
              {t("begin")}
            </Button>
          </div>
        ) : null}
        {snapshot?.files.length ? (
          <div
            className="max-h-44 overflow-auto border-b border-border"
            data-testid="git-conflict-files"
          >
            {snapshot.files.map((entry) => (
              <button
                type="button"
                key={entry.path}
                title={entry.path}
                aria-pressed={file?.path === entry.path}
                disabled={session.pending}
                onClick={() => c.select(entry.path)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-ui-xs hover:bg-surface-hover ${file?.path === entry.path ? "bg-accent" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                <span className="shrink-0 text-foreground-subtle">{t(`kind.${entry.kind}`)}</span>
              </button>
            ))}
          </div>
        ) : snapshot ? (
          <p className="px-3 py-4 text-ui-sm text-foreground-subtle">{t("empty")}</p>
        ) : null}
        {file ? (
          <>
            <p
              className="break-all border-b border-border px-3 py-2 font-mono text-ui-xs"
              data-testid="git-conflict-path"
            >
              {file.path}
            </p>
            <GitConflictThreeWay
              key={`${session.context.request.workspaceIdentity || session.context.request.workspacePath}:${file.path}`}
              controller={c}
              writable={writable}
            />
          </>
        ) : null}
        {c.confirmation ? (
          <section
            className="space-y-2 border-y border-border bg-surface px-3 py-3"
            data-testid="git-conflict-confirmation"
          >
            <p className="font-medium">{t(c.confirmation.kind)}</p>
            <p className="break-all text-ui-xs">
              {c.confirmation.kind === "begin" ? snapshot?.root : file?.path}
            </p>
            <p className="text-ui-xs text-foreground-subtle">{t(`${c.confirmation.kind}Hint`)}</p>
            {snapshot?.nativeCheck ? (
              <label className="flex items-start gap-2 text-ui-xs">
                <input
                  type="checkbox"
                  checked={nativeChecked}
                  onChange={(event) => setNativeChecked(event.target.checked)}
                />
                {t("nativeCheck")}
              </label>
            ) : null}
            {c.confirmation.kind === "mark" && !file?.editable ? (
              <label className="flex items-start gap-2 text-ui-xs">
                <input
                  type="checkbox"
                  checked={specialChecked}
                  onChange={(event) => setSpecialChecked(event.target.checked)}
                />
                {t("specialCheck")}
              </label>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={session.pending} onClick={c.cancel}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                size="sm"
                variant={c.confirmation.kind === "delete" ? "destructive" : "default"}
                data-testid="git-conflict-confirm"
                disabled={
                  !available ||
                  Boolean(snapshot?.nativeCheck && !nativeChecked) ||
                  (c.confirmation.kind === "mark" && !file?.editable && !specialChecked)
                }
                onClick={() => {
                  void c.confirm(nativeChecked, specialChecked);
                }}
              >
                {t("confirm")}
              </Button>
            </div>
          </section>
        ) : null}
        {c.owner?.integration && onIntegrate ? (
          <div className="space-y-2 border-t border-border px-3 py-2">
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "git.integration.continueHint" })}
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="git-conflict-integration"
              onClick={onIntegrate}
            >
              {intl.formatMessage({ id: "git.integration.title" })}
            </Button>
          </div>
        ) : (
          <GitOperationRecovery session={session} operation={c.owner} onComplete={c.refresh} />
        )}
      </div>
      {file ? (
        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border bg-panel px-3 py-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!writable || !file.editable || c.dirty}
            data-testid="git-conflict-delete"
            onClick={() => prepare("delete")}
          >
            {t("delete")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!writable || !file.editable || !c.dirty || !c.mixedAccepted || c.staleDraft}
            data-testid="git-conflict-save"
            onClick={() => prepare("save")}
          >
            {t("save")}
          </Button>
          <Button
            size="sm"
            disabled={!writable || !file.canMark || c.dirty}
            data-testid="git-conflict-mark"
            onClick={() => prepare("mark")}
          >
            {t("mark")}
          </Button>
        </footer>
      ) : null}
    </section>
  );
}
