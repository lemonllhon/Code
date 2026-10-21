import { Checkbox } from "@/components/ui/checkbox.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitCommitFileScope({
  includeUnstaged,
  hasUnstaged,
  fileCount,
  excludedCount,
  totalCount,
  disabled,
  onIncludeUnstagedChange,
  readOnly = false,
}: {
  includeUnstaged: boolean;
  hasUnstaged: boolean;
  fileCount: number;
  excludedCount: number;
  totalCount: number;
  disabled: boolean;
  onIncludeUnstagedChange: (value: boolean) => void;
  readOnly?: boolean;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-1 px-2 py-1 text-ui-sm">
      {!readOnly ? (
        <label className="flex items-center gap-2">
          <Checkbox
            className="size-3.5"
            data-testid="git-commit-include-unstaged"
            checked={includeUnstaged}
            disabled={disabled || !hasUnstaged}
            onCheckedChange={(value) => onIncludeUnstagedChange(value === true)}
          />
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "git.review.includeWorking" })}
          </span>
        </label>
      ) : (
        <p className="text-foreground-subtle">
          {intl.formatMessage({ id: "git.review.sourceReadOnly" })}
        </p>
      )}
      <span className="text-foreground-subtle" aria-hidden="true">
        {fileCount}/{totalCount}
      </span>
      <p data-testid="git-commit-scope-counts" className="sr-only">
        {intl.formatMessage(
          { id: "git.review.scopeCounts" },
          { selected: fileCount, excluded: excludedCount, total: totalCount },
        )}
      </p>
    </div>
  );
}
