import { useState } from "react";
import type { GitNetworkOperation } from "@lcode/shared";
import type { GitOperationSession } from "@/hooks/useGitOperationSession.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitOperationRecovery({
  session,
  operation,
  onComplete,
  onResolve,
}: {
  session: GitOperationSession;
  operation: GitNetworkOperation | null;
  onComplete?: () => void;
  onResolve?: () => void;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.workspace.${key}` });
  const [checked, setChecked] = useState(false);
  const preview = session.recovery;
  if (
    !operation ||
    operation.resolved ||
    !operation.targetPath ||
    !["conflict", "partial", "unknown", "running"].includes(operation.status)
  )
    return null;
  return (
    <section
      className="space-y-2 border-b border-border bg-surface px-3 py-2 text-ui-sm"
      data-testid="git-operation-recovery"
    >
      <p className="text-ui-xs text-foreground-subtle">{t("recoveryHint")}</p>
      {onResolve && operation.conflicts?.length ? (
        <Button size="sm" variant="outline" onClick={onResolve}>
          {intl.formatMessage({ id: "git.conflict.open" })}
        </Button>
      ) : null}
      {!preview ? (
        <Button
          size="sm"
          variant="outline"
          disabled={session.pending || !session.ready}
          onClick={() => {
            setChecked(false);
            void session.prepareRecovery(operation.requestId);
          }}
        >
          {t("checkRecovery")}
        </Button>
      ) : (
        <>
          {preview.conflicts.length ? (
            <p className="break-words text-destructive">
              {t("unresolved")}: {preview.conflicts.join(", ")}
            </p>
          ) : (
            <p>{t("recoveryReady")}</p>
          )}
          {preview.needsNativeConfirmation ? (
            <label className="flex items-start gap-2 text-ui-xs">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => setChecked(event.target.checked)}
                className="mt-0.5 size-3.5 shrink-0"
              />
              {t("confirmNativeStopped")}
            </label>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={session.pending}
              onClick={session.cancelRecovery}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              size="sm"
              disabled={
                session.pending ||
                !session.ready ||
                !preview.canComplete ||
                (preview.needsNativeConfirmation && !checked)
              }
              data-testid="git-operation-complete"
              onClick={() => {
                void session.completeRecovery(checked).then((result) => {
                  if (result?.status === "success") onComplete?.();
                });
              }}
            >
              {t("completeRecovery")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
