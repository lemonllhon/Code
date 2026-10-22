import { Plus, Minus, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitFileAction } from "@/hooks/useGitActions.js";

export function GitFileActionButtons({
  staged,
  all,
  disabled,
  onAction,
}: {
  staged: boolean;
  all?: boolean;
  disabled: boolean;
  onAction: (action: GitFileAction) => void;
}) {
  const { intl } = useLCodeIntl();
  const primary = staged ? "unstage" : "stage";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {([primary, "discard"] as const).map((action) => {
        const Icon = action === "stage" ? Plus : action === "unstage" ? Minus : Undo2;
        const label = intl.formatMessage({ id: `git.files.${action}${all ? "All" : ""}` });
        return (
          <Button
            key={action}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 text-foreground-subtle disabled:opacity-100"
            disabled={disabled}
            aria-label={label}
            title={label}
            data-testid={`git-file-${action}${all ? "-all" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onAction(action);
            }}
          >
            <Icon className="size-3.5" />
          </Button>
        );
      })}
    </div>
  );
}
