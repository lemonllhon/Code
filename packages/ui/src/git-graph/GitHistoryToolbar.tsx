import { ListFilter, PanelBottom, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import type { GitHistoryController } from "@/hooks/useGitHistory.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitHistoryLocate } from "./GitHistoryLocate.js";
import { GitHistoryCandidatePicker } from "./GitHistoryCandidatePicker.js";

export function GitHistoryToolbar({
  history,
  detailHidden,
  onShowDetail,
}: {
  history: GitHistoryController;
  detailHidden: boolean;
  onShowDetail: () => void;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.history.${key}` });
  const [advanced, setAdvanced] = useState(false);
  const advancedId = useId();
  const [draft, setDraft] = useState({ ref: "", author: "", search: "", since: "", until: "" });
  const [regex, setRegex] = useState(false),
    [caseSensitive, setCaseSensitive] = useState(false);
  useEffect(() => {
    const f = history.filters;
    setDraft({
      ref: f.ref ?? "",
      author: f.author ?? "",
      search: f.search ?? "",
      since: f.since?.slice(0, 10) ?? "",
      until: f.until?.slice(0, 10) ?? "",
    });
    setRegex(f.searchMode === "regex");
    setCaseSensitive(Boolean(f.caseSensitive));
  }, [history.filters]);
  const enabled = history.session.ready && !history.session.pending;
  // 清空草稿还没有清除已应用条件，重置入口必须同时依据两者，避免只能刷新旧筛选。
  const canReset =
    regex ||
    caseSensitive ||
    Object.values(draft).some(Boolean) ||
    Object.values(history.filters).some(Boolean);
  const update = (key: keyof typeof draft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    history.cancel();
  };
  return (
    <form
      className="shrink-0 border-b border-border bg-background"
      data-testid="git-history-toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        history.session.clearError();
        void history.refresh({
          ref: draft.ref || undefined,
          author: draft.author || undefined,
          search: draft.search || undefined,
          searchMode: regex ? "regex" : undefined,
          caseSensitive: caseSensitive || undefined,
          since: draft.since ? `${draft.since}T00:00:00.000Z` : undefined,
          until: draft.until ? `${draft.until}T23:59:59.999Z` : undefined,
        });
      }}
    >
      <div className="flex h-10 min-w-0 items-center gap-1 px-2">
        <Input
          className="h-7 min-w-0 flex-1 rounded-sm text-mobile-input-safe md:text-ui-sm"
          aria-label={t("search")}
          placeholder={t("search")}
          value={draft.search}
          maxLength={256}
          disabled={!enabled}
          onChange={(event) => update("search", event.target.value)}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="aria-pressed:bg-selected"
          aria-pressed={regex}
          aria-label={t("regex")}
          title={t("regex")}
          disabled={!enabled}
          onClick={() => {
            setRegex((v) => !v);
            history.cancel();
          }}
        >
          <span className="font-mono text-ui-sm">.*</span>
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="aria-pressed:bg-selected"
          aria-pressed={caseSensitive}
          aria-label={t("caseSensitive")}
          title={t("caseSensitive")}
          disabled={!enabled}
          onClick={() => {
            setCaseSensitive((v) => !v);
            history.cancel();
          }}
        >
          <span className="text-ui-sm">Aa</span>
        </Button>
        <GitHistoryLocate history={history} onShow={onShowDetail} />
        <Button
          type="submit"
          size="icon-sm"
          variant="ghost"
          disabled={!enabled}
          aria-label={t("filter")}
          title={t("filter")}
          data-testid="git-history-filter"
        >
          <Search className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-expanded={advanced}
          aria-controls={advancedId}
          aria-label={t("advanced")}
          title={t("advanced")}
          data-testid="git-history-advanced-toggle"
          onClick={() => setAdvanced((value) => !value)}
        >
          <ListFilter className="size-3.5" />
        </Button>
        {canReset ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={!enabled}
            aria-label={t("reset")}
            title={t("reset")}
            data-testid="git-history-reset"
            onClick={() => {
              setRegex(false);
              setCaseSensitive(false);
              setDraft({ ref: "", author: "", search: "", since: "", until: "" });
              history.cancel();
              history.session.clearError();
              void history.refresh({});
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        {detailHidden ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            title={t("showDetail")}
            aria-label={t("showDetail")}
            onClick={onShowDetail}
          >
            <PanelBottom className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!enabled}
          title={t("refresh")}
          aria-label={t("refresh")}
          onClick={() => {
            void history.refresh(history.filters);
            void history.session.loadReceipt();
          }}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {advanced ? (
        <div
          id={advancedId}
          data-testid="git-history-advanced"
          className="grid max-h-44 grid-cols-2 gap-2 overflow-auto border-t border-border px-2 py-2 @min-[760px]/history:grid-cols-4"
        >
          <div className="col-span-2 flex min-w-0 items-center @min-[760px]/history:col-span-1">
            <Input
              className="h-7 min-w-0 flex-1 rounded-sm text-mobile-input-safe md:text-ui-sm"
              aria-label={t("ref")}
              placeholder={t("ref")}
              value={draft.ref}
              maxLength={1024}
              disabled={!enabled}
              onChange={(event) => update("ref", event.target.value)}
            />
            <GitHistoryCandidatePicker
              history={history}
              kind="ref"
              onSelect={(value) => update("ref", value)}
            />
          </div>
          <div className="col-span-2 flex min-w-0 items-center @min-[760px]/history:col-span-1">
            <Input
              className="h-7 min-w-0 flex-1 rounded-sm text-mobile-input-safe md:text-ui-sm"
              aria-label={t("author")}
              placeholder={t("author")}
              value={draft.author}
              maxLength={256}
              disabled={!enabled}
              onChange={(event) => update("author", event.target.value)}
            />
            <GitHistoryCandidatePicker
              history={history}
              kind="author"
              onSelect={(value) => update("author", value)}
            />
          </div>
          {(["since", "until"] as const).map((key) => (
            <label key={key} className="min-w-0 space-y-1 text-ui-xs">
              {t(key)}
              <Input
                type="date"
                className="h-7 min-w-0 rounded-sm text-mobile-input-safe md:text-ui-sm"
                aria-label={t(key)}
                value={draft[key]}
                max={key === "since" ? draft.until || undefined : undefined}
                min={key === "until" ? draft.since || undefined : undefined}
                disabled={!enabled}
                onChange={(event) => update(key, event.target.value)}
              />
            </label>
          ))}
        </div>
      ) : null}
    </form>
  );
}
