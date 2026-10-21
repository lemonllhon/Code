import { useState } from "react";
import { Eye, Play, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useGitStash } from "@/hooks/useGitStash.js";
import type { GitOperationScope } from "@/hooks/useGitOperationSession.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitOperationResult } from "./GitOperationResult.js";
import { GitOperationRecovery } from "./GitOperationRecovery.js";

export function GitStashPane({
  onResolveConflicts,
  ...props
}: GitOperationScope & { onResolveConflicts?: () => void }) {
  const stash = useGitStash(props),
    { session } = stash;
  const { intl, locale } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.workspace.${key}` });
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false),
    [restoreIndex, setRestoreIndex] = useState(false),
    [page, setPage] = useState(0);
  const entries = stash.snapshot?.entries ?? [],
    confirmation = stash.confirmation;
  const enabled = session.ready && !session.pending && Boolean(stash.snapshot);
  const writable = enabled && !stash.snapshot?.blocked;
  const operation = stash.snapshot?.operation ?? session.receipt;
  const pageCount = Math.max(1, Math.ceil(entries.length / 50)),
    currentPage = Math.min(page, pageCount - 1);
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-ui-sm text-foreground"
      data-testid="git-stash-pane"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex-1 font-medium">
          Stash <span className="ml-1 font-normal text-foreground-subtle">{entries.length}</span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("refresh")}
          title={t("refresh")}
          disabled={session.pending || !session.ready}
          onClick={() => {
            void stash.refresh();
            void session.loadReceipt();
          }}
        >
          <RefreshCw className={session.pending ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <p className="border-b border-border px-3 py-2 text-ui-xs text-foreground-subtle">
          {t("sharedStashes")}
        </p>
        <div className="space-y-2 border-b border-border px-3 py-2">
          <Input
            aria-label={t("stashMessage")}
            placeholder={t("stashMessage")}
            maxLength={1024}
            value={message}
            disabled={!writable}
            onChange={(event) => setMessage(event.target.value)}
          />
          <label className="flex items-center gap-2 text-ui-xs">
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={!writable}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
              className="size-3.5"
            />
            {t("includeUntracked")}
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui-xs text-foreground-subtle">{t("keepIgnored")}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={!writable}
              data-testid="git-stash-save"
              onClick={() => {
                void stash.prepareSave(includeUntracked, message);
              }}
            >
              {t("saveStash")}
            </Button>
          </div>
        </div>
        {stash.snapshot?.blocked ? (
          <p className="px-3 py-2 text-ui-xs text-warning" role="status">
            {t("reserved")}
          </p>
        ) : null}
        <GitOperationResult receipt={operation} error={session.error} />
        <GitOperationRecovery
          onResolve={onResolveConflicts}
          session={session}
          operation={operation}
          onComplete={() => {
            void stash.refresh();
          }}
        />
        <label className="flex items-center gap-2 border-b border-border px-3 py-2 text-ui-xs">
          <input
            type="checkbox"
            checked={restoreIndex}
            disabled={!writable}
            onChange={(event) => setRestoreIndex(event.target.checked)}
            className="size-3.5"
          />
          {t("restoreIndex")}
        </label>
        {entries.slice(currentPage * 50, (currentPage + 1) * 50).map((entry) => (
          <div
            key={entry.selector}
            className="border-b border-border px-3 py-1.5 hover:bg-surface-hover"
            data-testid="git-stash-entry"
          >
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate" title={entry.subject}>
                {entry.subject}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("previewStash")} ${entry.selector}`}
                title={t("previewStash")}
                disabled={!enabled}
                onClick={() => {
                  void stash.previewEntry(entry);
                }}
              >
                <Eye className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("applyStash")} ${entry.selector}`}
                title={t("applyStash")}
                disabled={!writable}
                onClick={() => {
                  void stash.prepareApply(entry, restoreIndex);
                }}
              >
                <Play className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${t("dropStash")} ${entry.selector}`}
                title={t("dropStash")}
                disabled={!enabled}
                onClick={() => stash.prepareDrop(entry)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <p className="flex flex-wrap gap-x-2 text-ui-xs text-foreground-subtle">
              <span className="font-mono">{entry.oid.slice(0, 12)}</span>
              <span>{entry.selector}</span>
              <time>{new Date(entry.timestamp * 1000).toLocaleString(locale)}</time>
            </p>
          </div>
        ))}
        {!entries.length && stash.snapshot ? (
          <p className="px-3 py-5 text-ui-sm text-foreground-subtle">{t("emptyStash")}</p>
        ) : null}
        {pageCount > 1 ? (
          <div className="flex items-center justify-end gap-2 border-b border-border px-3 py-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={!currentPage}
              onClick={() => setPage(currentPage - 1)}
            >
              ‹
            </Button>
            <span className="text-ui-xs">
              {currentPage + 1}/{pageCount}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              ›
            </Button>
          </div>
        ) : null}
        {confirmation ? (
          <section
            className="space-y-2 border-b border-border bg-surface px-3 py-3"
            data-testid="git-stash-confirmation"
          >
            <p className="font-medium">
              {t(
                confirmation.kind === "save"
                  ? "saveStash"
                  : confirmation.kind === "apply"
                    ? "applyStash"
                    : "dropStash",
              )}
            </p>
            {confirmation.kind === "save" ? (
              <>
                <p className="break-all text-ui-xs">
                  {t("wholeRepository")}: {confirmation.root}
                </p>
                <p className="text-ui-xs">
                  {confirmation.files.length} {t("files")} ·{" "}
                  {t(confirmation.includeUntracked ? "includeUntracked" : "keepUntracked")}
                </p>
                <ul className="max-h-28 overflow-auto text-ui-xs">
                  {confirmation.files.map((path) => (
                    <li className="break-all" key={path}>
                      {path}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p className="break-words">{confirmation.entry.subject}</p>
                <p className="break-all font-mono text-ui-xs">{confirmation.entry.oid}</p>
                <p className="text-ui-xs text-foreground-subtle">
                  {t(
                    confirmation.kind === "drop"
                      ? "dropHint"
                      : confirmation.restoreIndex
                        ? "applyIndexHint"
                        : "applyHint",
                  )}
                </p>
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={session.pending} onClick={stash.cancel}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                size="sm"
                variant={confirmation.kind === "drop" ? "destructive" : "default"}
                disabled={!enabled || (confirmation.kind === "save" && !confirmation.files.length)}
                data-testid="git-stash-confirm"
                onClick={() => {
                  void stash.confirm();
                }}
              >
                {t("confirm")}
              </Button>
            </div>
          </section>
        ) : null}
        {stash.preview ? (
          <section className="min-w-0 border-b border-border" data-testid="git-stash-preview">
            <p className="truncate px-3 py-2 font-mono text-ui-xs">{stash.preview.oid}</p>
            {stash.preview.sections.map((section) => (
              <details key={section.source} open className="min-w-0 border-t border-border">
                <summary className="cursor-pointer px-3 py-1.5 font-medium">
                  {t(`source.${section.source}`)}
                </summary>
                <pre className="max-h-80 overflow-auto bg-surface px-3 py-2 font-mono text-ui-xs">
                  {section.patch || t("noDiff")}
                </pre>
                {section.truncated ? (
                  <p className="px-3 py-1 text-ui-xs text-warning">{t("truncated")}</p>
                ) : null}
              </details>
            ))}
          </section>
        ) : null}
      </div>
    </section>
  );
}
