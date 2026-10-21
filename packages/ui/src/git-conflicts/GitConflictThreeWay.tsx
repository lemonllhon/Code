import { useState, type CSSProperties } from "react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitConflictsController } from "@/hooks/useGitConflicts.js";

export function GitConflictThreeWay({
  controller,
  writable,
}: {
  controller: GitConflictsController;
  writable: boolean;
}) {
  const { intl } = useLCodeIntl(),
    file = controller.file!;
  const t = (key: string) => intl.formatMessage({ id: `git.conflict.${key}` });
  const settings = useLCodeStore((state) => state.codePreviewSettings),
    theme = useLCodeStore((state) => state.theme);
  const [tab, setTab] = useState<"base" | "ours" | "theirs" | "result">("result");
  return (
    <div
      className="@container/conflict min-h-0 min-w-0 flex-1 overflow-auto"
      data-testid="git-conflict-three-way"
    >
      <nav
        className="flex gap-1 border-b border-border px-2 py-1 @min-[900px]/conflict:hidden"
        aria-label={t("versions")}
      >
        {(["base", "ours", "theirs", "result"] as const).map((key) => (
          <Button
            type="button"
            key={key}
            size="xs"
            variant={tab === key ? "secondary" : "ghost"}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            data-testid={`git-conflict-tab-${key}`}
          >
            {t(key)}
          </Button>
        ))}
      </nav>
      <div
        className="min-w-0 @min-[900px]/conflict:grid @min-[900px]/conflict:grid-cols-3"
        data-testid="git-conflict-versions"
      >
        {(["ours", "base", "theirs"] as const).map((key) => {
          const version = file[key];
          return (
            <section
              key={key}
              className={`min-w-0 border-b border-border @min-[900px]/conflict:border-r ${tab === key ? "block" : "hidden @min-[900px]/conflict:block"}`}
              data-testid={`git-conflict-version-${key}`}
            >
              <header className="flex items-center justify-between gap-1 bg-surface px-3 py-1.5 text-ui-xs">
                <span>{t(key)}</span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={!writable || !file.editable || version.kind !== "text"}
                  onClick={() => {
                    controller.useVersion(key);
                    setTab("result");
                  }}
                >
                  {t("useVersion")}
                </Button>
              </header>
              <p
                className="truncate border-b border-border px-3 py-1 font-mono text-ui-xs text-foreground-subtle"
                title={`${version.oid ?? "—"} ${version.mode ?? "—"}`}
              >
                {version.oid?.slice(0, 12) ?? "—"} · {version.mode ?? "—"}
              </p>
              {version.kind === "text" ? (
                key === "base" || file.base.kind !== "text" ? (
                  <pre
                    className="max-h-80 min-h-32 overflow-auto px-3 py-2 font-mono"
                    style={{ fontSize: settings.fontSizePx }}
                  >
                    {version.text}
                  </pre>
                ) : (
                  <div className="h-80 min-w-0" data-testid={`git-conflict-diff-${key}`}>
                    <DiffViewer
                      oldFile={{ name: file.path, contents: file.base.text! }}
                      newFile={{ name: file.path, contents: version.text! }}
                      fontSizePx={settings.fontSizePx}
                      lightTheme={settings.lightTheme}
                      darkTheme={settings.darkTheme}
                      themeType={resolveTheme(theme)}
                    />
                  </div>
                )
              ) : (
                <p className="px-3 py-4 text-ui-xs text-foreground-subtle">
                  {t(`versionKind.${version.kind}`)} · {version.size} B
                </p>
              )}
            </section>
          );
        })}
      </div>
      <section
        className={`min-w-0 ${tab === "result" ? "block" : "hidden @min-[900px]/conflict:block"}`}
        data-testid="git-conflict-result-section"
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-1.5 text-ui-xs">
          <span>
            {t("result")}
            {controller.dirty ? ` · ${t("unsaved")}` : ""}
          </span>
          <label className="flex items-center gap-2">
            {t("lineEndings")}
            <select
              aria-label={t("lineEndings")}
              value={controller.mixedAccepted ? controller.eol : "choose"}
              disabled={!writable || !file.editable}
              onChange={(event) => controller.setEol(event.target.value as "lf" | "crlf")}
              className="rounded border border-input-border bg-input px-1 py-0.5 text-ui-xs"
            >
              {!controller.mixedAccepted ? (
                <option value="choose" disabled>
                  {t("chooseEol")}
                </option>
              ) : null}
              <option value="lf">LF</option>
              <option value="crlf">CRLF</option>
            </select>
          </label>
        </header>
        {file.editable ? (
          <>
            <textarea
              aria-label={t("result")}
              data-testid="git-conflict-result"
              value={controller.draft}
              disabled={!writable}
              spellCheck={false}
              maxLength={256 * 1024}
              onChange={(event) => controller.edit(event.target.value)}
              className="block min-h-64 w-full resize-y border-0 bg-input px-3 py-2 font-mono text-mobile-input-safe @min-[640px]/conflict:[font-size:var(--conflict-code-font-size)] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
              style={{ "--conflict-code-font-size": `${settings.fontSizePx}px` } as CSSProperties}
            />
            {!controller.mixedAccepted ? (
              <p className="px-3 py-2 text-ui-xs text-warning">{t("mixedEol")}</p>
            ) : null}
          </>
        ) : (
          <p className="px-3 py-4 text-ui-xs text-warning">
            {t("specialHint")} · {t(`versionKind.${file.result.kind}`)}
          </p>
        )}
      </section>
    </div>
  );
}
