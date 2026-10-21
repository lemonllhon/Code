import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Group } from "react-resizable-panels";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitHistoryController } from "@/hooks/useGitHistory.js";
import { GitHistoryResetForm } from "./GitHistoryResetForm.js";
import { GitHistoryFiles } from "./GitHistoryFiles.js";
import { GitHistoryDiff } from "./GitHistoryDiff.js";

export function GitHistoryDetail({
  history,
  onClose,
  panelRequest,
}: {
  history: GitHistoryController;
  onClose: () => void;
  panelRequest?: { hash: string; sequence: number; kind: "tag" | "reset" };
}) {
  const { detail, file, session } = history;
  const { intl, locale } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.history.${key}` });
  const [tool, setTool] = useState<"files" | "tag" | "reset">("files");
  const [mainline, setMainline] = useState<number>();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [signed, setSigned] = useState(false);
  useEffect(() => {
    if (panelRequest && panelRequest.hash === detail?.hash) setTool(panelRequest.kind);
  }, [panelRequest, detail?.hash]);
  if (!detail) return null;
  const enabled = session.ready && !session.pending;
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="git-history-detail"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface/40 px-2 text-ui-sm">
        <span className="font-medium">{t("detail")}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-foreground-subtle"
          title={detail.hash}
        >
          {detail.hash.slice(0, 12)}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("closeDetail")}
          title={t("closeDetail")}
          // 预览尚未返回时关闭只清投影，迟到结果会重新出现；沿用 pending 边界阻止该竞态。
          disabled={!enabled}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Group
          orientation="vertical"
          className="h-full min-h-0"
          resizeTargetMinimumSize={{ coarse: 20, fine: 10 }}
        >
          <ResizablePanel
            id="git-history-files-panel"
            defaultSize={file ? "55%" : "100%"}
            minSize="20%"
          >
            <div className="flex h-full min-h-0 min-w-0 flex-col">
              <div className="max-h-[40%] shrink-0 space-y-1 overflow-auto border-b border-border px-3 py-2 text-ui-sm">
                <p className="break-words">
                  {t("author")}: {detail.authorName} &lt;{detail.authorEmail}&gt; ·{" "}
                  {new Date(detail.authoredAtMs).toLocaleString(locale)}
                </p>
                <p className="break-words text-foreground-subtle">
                  {t("committer")}: {detail.committerName} &lt;{detail.committerEmail}&gt; ·{" "}
                  {new Date(detail.committedAtMs).toLocaleString(locale)}
                </p>
                <pre
                  className="whitespace-pre-wrap break-words font-sans text-ui-sm"
                  data-testid="git-history-message"
                >
                  {detail.message}
                </pre>
              </div>
              {detail.parents.length > 1 ? (
                <label className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-ui-sm">
                  {t("parent")}
                  <select
                    aria-label={t("parent")}
                    value={detail.parent}
                    className="h-7 min-w-0 flex-1 rounded-sm border border-input-border bg-input px-2 text-mobile-input-safe md:text-ui-sm"
                    disabled={!enabled}
                    onChange={(event) => {
                      void history.select(detail.hash, Number(event.target.value));
                    }}
                  >
                    {detail.parents.map((hash, index) => (
                      <option key={hash} value={index + 1}>
                        {index + 1} · {hash.slice(0, 12)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {tool === "reset" ? (
                <GitHistoryResetForm history={history} />
              ) : tool === "tag" ? (
                <form
                  className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2"
                  data-testid="git-history-tag-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void history.prepareTag(name, message, signed);
                  }}
                >
                  <Input
                    className="text-mobile-input-safe md:text-ui-sm"
                    aria-label={t("tagName")}
                    placeholder={t("tagName")}
                    value={name}
                    maxLength={255}
                    disabled={!enabled}
                    onChange={(event) => {
                      setName(event.target.value);
                      history.cancel();
                    }}
                  />
                  <textarea
                    aria-label={t("tagMessage")}
                    placeholder={t("tagMessage")}
                    className="min-h-20 w-full rounded-sm border border-input-border bg-input px-2 py-1 text-mobile-input-safe md:text-ui-sm"
                    value={message}
                    maxLength={16384}
                    disabled={!enabled}
                    onChange={(event) => {
                      setMessage(event.target.value);
                      history.cancel();
                    }}
                  />
                  <label className="flex items-start gap-2 text-ui-sm">
                    <input
                      type="checkbox"
                      checked={signed}
                      className="mt-0.5 size-3.5"
                      disabled={!enabled}
                      onChange={(event) => {
                        setSigned(event.target.checked);
                        history.cancel();
                      }}
                    />
                    {t("sign")}
                  </label>
                  <p className="text-ui-xs text-foreground-subtle">{t("tagHint")}</p>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      type="submit"
                      disabled={!enabled || !name || !message.trim()}
                      data-testid="git-history-tag-preview"
                    >
                      {t("preview")}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="min-h-0 flex-1 overflow-auto" data-testid="git-history-files">
                  <GitHistoryFiles
                    files={detail.files}
                    selected={file?.path}
                    disabled={!enabled}
                    onSelect={(path) => {
                      void history.selectFile(path);
                    }}
                  />
                  {detail.filesTruncated ? (
                    <p className="px-3 py-2 text-ui-xs text-warning">{t("filesTruncated")}</p>
                  ) : null}
                </div>
              )}
            </div>
          </ResizablePanel>
          {file ? (
            <>
              <ResizableHandle
                aria-label={t("resizeDiff")}
                className="!m-0 !h-1.5 !w-full !translate-y-0 border-y border-border ![mask-image:none]"
              />
              <ResizablePanel id="git-history-diff-resize" defaultSize="45%" minSize="25%">
                <GitHistoryDiff file={file} disabled={!enabled} onClose={history.clearFile} />
              </ResizablePanel>
            </>
          ) : null}
        </Group>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border bg-background px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          data-testid="git-history-cherry-pick"
          disabled={!enabled || (detail.parents.length > 1 && !mainline)}
          onClick={() => {
            void history.prepareAction("cherry-pick", detail.hash, mainline);
          }}
        >
          Cherry-pick
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="git-history-revert"
          disabled={!enabled || (detail.parents.length > 1 && !mainline)}
          onClick={() => {
            void history.prepareAction("revert", detail.hash, mainline);
          }}
        >
          Revert
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!enabled}
          data-testid="git-history-tag-open"
          aria-pressed={tool === "tag"}
          onClick={() => {
            setTool((value) => (value === "tag" ? "files" : "tag"));
            history.cancel();
          }}
        >
          {t("tag")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!enabled}
          aria-pressed={tool === "reset"}
          onClick={() => {
            setTool((value) => (value === "reset" ? "files" : "reset"));
            history.cancel();
          }}
        >
          Reset…
        </Button>
        {detail.parents.length > 1 ? (
          <label className="flex w-full items-center gap-2 text-ui-xs">
            {t("mainlineChoice")}
            <select
              aria-label={t("mainlineChoice")}
              className="h-7 min-w-0 flex-1 rounded-sm border border-input-border bg-input px-2 text-mobile-input-safe md:text-ui-sm"
              value={mainline ?? ""}
              disabled={!enabled}
              onChange={(event) => {
                setMainline(event.target.value ? Number(event.target.value) : undefined);
                history.cancel();
              }}
            >
              <option value="">{t("chooseMainline")}</option>
              {detail.parents.map((hash, index) => (
                <option key={hash} value={index + 1}>
                  {index + 1} · {hash.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </footer>
    </section>
  );
}
