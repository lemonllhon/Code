import type { GitRepositorySummary, SessionExecutionMode } from "@lcode/shared";
import { GitBranchIcon, InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitCommitExecutionSummary({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  executionMode,
  summary,
  locked,
  fileCount,
  added,
  removed,
  onRefreshGit,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  executionMode: SessionExecutionMode;
  summary: GitRepositorySummary;
  locked: boolean;
  fileCount: number;
  added: number;
  removed: number;
  onRefreshGit: () => void;
}) {
  const { intl, locale } = useLCodeIntl();
  const text = (field: string) =>
    intl.formatMessage({ id: `git.commitWorkflow.${executionMode}.${field}` });
  const number = new Intl.NumberFormat(locale);
  return (
    <div
      className="flex h-10 min-w-0 shrink-0 items-center gap-2 px-3 text-ui-sm"
      data-testid="git-commit-execution-summary"
    >
      {locked ? (
        <span className="flex min-w-0 items-center gap-1 font-mono text-ui-sm">
          <GitBranchIcon className="size-4 shrink-0" />
          <span className="truncate">
            {summary.branchName ?? intl.formatMessage({ id: "git.head.detached" })}
          </span>
        </span>
      ) : (
        <GitBranchSwitcher
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          gitSummary={summary}
          dirtyFileCount={fileCount}
          onRefreshGit={onRefreshGit}
          className="min-w-0 px-0 pt-0"
          triggerClassName="h-7 max-w-56 justify-start px-1.5 text-foreground-subtle [&>span]:max-w-40"
          popoverSide="bottom"
          popoverClassName="w-80 max-w-[calc(100vw-2rem)]"
          branchListClassName="max-h-56"
          showFooterActions={false}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-foreground-subtle">{text("branchLabel")}</span>
      <div className="flex shrink-0 gap-1.5 font-mono text-ui-sm">
        <span className="text-diff-added">+{number.format(added)}</span>
        <span className="text-diff-removed">−{number.format(removed)}</span>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            data-testid="git-review-context"
            aria-label={intl.formatMessage({ id: "git.review.executionDetails" })}
          >
            <InfoIcon className="size-3.5 text-foreground-subtle" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="max-w-80 gap-2 rounded-md text-ui-sm"
          data-testid="git-review-context-content"
        >
          <p>{text("hint")}</p>
          <p className="text-foreground-subtle">
            {intl.formatMessage({ id: "git.commitWorkflow.directory" })}
          </p>
          <p className="break-all font-mono">{workspacePath}</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
