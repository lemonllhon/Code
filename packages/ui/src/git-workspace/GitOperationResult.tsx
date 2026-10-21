import type { GitNetworkOperation } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitOperationResult({
  receipt,
  error,
}: {
  receipt: GitNetworkOperation | null;
  error: string | null;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.workspace.${key}` });
  return (
    <>
      {error ? (
        <p
          role="alert"
          className="break-words px-3 py-2 text-ui-sm text-destructive"
          data-testid="git-workspace-error"
        >
          {t(`error.${error}`)}
        </p>
      ) : null}
      {receipt ? (
        <section
          role="status"
          className="space-y-1 border-b border-border px-3 py-2 text-ui-xs"
          data-testid="git-workspace-receipt"
        >
          <p>
            {t(`kind.${receipt.kind}`)} ·{" "}
            {receipt.resolved ? t("resolved") : t(`status.${receipt.status}`)}
          </p>
          <p className="text-foreground-subtle">{receipt.finishedAt ?? receipt.startedAt}</p>
          {receipt.targetPath ? <p className="break-all">{receipt.targetPath}</p> : null}
          {receipt.filePath ? <p className="break-all font-mono">{receipt.filePath}</p> : null}
          {receipt.stashOid ? <p className="font-mono">{receipt.stashOid.slice(0, 12)}</p> : null}
          {receipt.code && !receipt.resolved ? (
            <p className="break-words text-destructive">{t(`error.${receipt.code}`)}</p>
          ) : null}
          {receipt.conflicts?.length && !receipt.resolved ? (
            <ul className="max-h-32 overflow-auto">
              {receipt.conflicts.map((file) => (
                <li className="break-all py-0.5" key={file.path}>
                  {file.path} · {file.stages.map((stage) => stage.stage).join("/")}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
