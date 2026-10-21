import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import type { GitHistoryFile } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useLCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { useGitHistoryDiffOptions } from "@/hooks/useGitHistoryDiffOptions.js";

export function GitHistoryDiff({
  file,
  disabled,
  onClose,
}: {
  file: GitHistoryFile;
  disabled: boolean;
  onClose: () => void;
}) {
  const { intl } = useLCodeIntl();
  const diffOptions = useGitHistoryDiffOptions();
  const settings = useLCodeStore((state) => state.codePreviewSettings);
  const theme = useLCodeStore((state) => state.theme);
  const text = (version: GitHistoryFile["before"]) =>
    version.kind === "text" || version.kind === "absent";
  const label = intl.formatMessage({ id: "git.history.closeDiff" });
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="git-history-diff-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface/40 px-2">
        <span className="min-w-0 flex-1 truncate text-ui-sm" title={file.path}>
          {file.path}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={disabled}
          aria-label={label}
          title={label}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {text(file.before) && text(file.after) ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="git-history-diff">
          <DiffViewer
            options={diffOptions}
            oldFile={{ name: file.path, contents: file.before.text ?? "" }}
            newFile={{ name: file.path, contents: file.after.text ?? "" }}
            fontSizePx={settings.fontSizePx}
            lightTheme={settings.lightTheme}
            darkTheme={settings.darkTheme}
            themeType={resolveTheme(theme)}
          />
        </div>
      ) : (
        <p
          className="min-h-0 flex-1 overflow-auto break-words px-3 py-3 text-ui-sm"
          data-testid="git-history-special"
        >
          {[file.before, file.after]
            .map(
              (version) =>
                `${intl.formatMessage({ id: `git.conflict.versionKind.${version.kind}` })} (${version.size} B)`,
            )
            .join(" → ")}
        </p>
      )}
    </div>
  );
}
