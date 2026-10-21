import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitHistoryController } from "@/hooks/useGitHistory.js";
export function GitHistoryConfirmation({ history }: { history: GitHistoryController }) {
  const { confirmation, session } = history;
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.history.${key}` });
  const [discard, setDiscard] = useState(false);
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    setDiscard(false);
    element.current?.focus();
  }, [confirmation]);
  if (!confirmation) return null;
  const enabled = session.ready && !session.pending;
  const hard = confirmation.kind === "reset" && confirmation.preview.mode === "hard";
  return (
    <section
      ref={element}
      tabIndex={-1}
      className="max-h-[45%] shrink-0 space-y-2 overflow-auto border-t border-border bg-surface px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-input-border-focused"
      data-testid="git-history-confirmation"
    >
      <p className="font-medium">
        {confirmation.kind === "tag"
          ? confirmation.preview.signed
            ? t("signedTag")
            : t("annotatedTag")
          : confirmation.kind === "reset"
            ? `${confirmation.preview.recovery ? t("restoreReset") : "Reset"} · ${confirmation.preview.mode}`
            : confirmation.preview.mode}
      </p>
      <p className="break-all text-ui-xs">{confirmation.preview.root}</p>
      <p className="break-all font-mono text-ui-xs">
        {confirmation.kind === "tag"
          ? confirmation.preview.hash
          : `${confirmation.preview.head} → ${confirmation.preview.target}`}
      </p>
      {confirmation.kind === "tag" ? (
        <>
          <p className="break-words">
            {confirmation.preview.name} · {confirmation.preview.signer ?? t("annotatedTag")}
          </p>
          <pre className="whitespace-pre-wrap break-words font-sans text-ui-sm">
            {confirmation.preview.message}
          </pre>
        </>
      ) : confirmation.kind === "action" ? (
        <>
          {confirmation.preview.targets ? (
            <ol className="space-y-1 font-mono text-ui-xs" data-testid="git-history-batch-order">
              {confirmation.preview.targets.map((hash, index) => (
                <li key={hash} className="break-all">
                  {index + 1}. {hash}
                </li>
              ))}
            </ol>
          ) : null}
          {confirmation.preview.mainline ? (
            <p>
              {t("mainlineChoice")}: {confirmation.preview.mainline}
            </p>
          ) : null}
          <p className="text-ui-xs text-foreground-subtle">{t("actionHint")}</p>
        </>
      ) : (
        <>
          <p className="text-ui-xs text-foreground-subtle">
            {t(`resetMode.${confirmation.preview.mode}`)}
          </p>
          <p className="text-ui-xs text-foreground-subtle">{t("resetBackup")}</p>
          {hard ? (
            <label className="flex items-start gap-2 text-ui-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 shrink-0"
                disabled={!enabled}
                checked={discard}
                onChange={(event) => setDiscard(event.target.checked)}
              />
              {t(confirmation.preview.recovery ? "restoreConfirm" : "resetDiscard")}
            </label>
          ) : null}
        </>
      )}
      <div className="sticky bottom-0 flex justify-end gap-2 bg-surface py-1">
        <Button size="sm" variant="ghost" disabled={!enabled} onClick={history.cancel}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button
          size="sm"
          disabled={!enabled || (hard && !discard)}
          data-testid="git-history-confirm"
          onClick={() => {
            void history.confirm(discard);
          }}
        >
          {t("confirm")}
        </Button>
      </div>
    </section>
  );
}
