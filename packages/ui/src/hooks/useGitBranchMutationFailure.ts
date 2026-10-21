import { useCallback } from "react";
import type { GitBranchMutationResult } from "@lcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  getPrimaryGitBranchIssue,
  resolveGitBranchIssueMessageId,
  summarizeGitBranchIssuePaths,
} from "@/git-branch-switcher/display.js";
import { formatGitBranchIssuePathList } from "@/git-branch-switcher/switchAssist.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function useGitBranchMutationFailure() {
  const { intl, locale } = useLCodeIntl();
  return useCallback(
    (result: GitBranchMutationResult) => {
      const issue = getPrimaryGitBranchIssue(result.issues);
      const messageId = resolveGitBranchIssueMessageId(issue);
      if (!issue) {
        toast(intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
        return;
      }
      if (messageId) {
        const { visiblePaths, remainingCount } = summarizeGitBranchIssuePaths(issue.paths);
        const extraPaths =
          remainingCount > 0
            ? intl.formatMessage(
                { id: "git.branchSwitcher.error.moreFiles" },
                { count: new Intl.NumberFormat(locale).format(remainingCount) },
              )
            : "";
        toast(
          intl.formatMessage(
            { id: messageId },
            {
              branchName: issue.detail ?? result.branchName ?? "",
              paths: formatGitBranchIssuePathList(locale, visiblePaths),
              extraPaths,
            },
          ),
        );
        return;
      }
      const fallback = issue.detail?.trim() || issue.message.trim();
      toast(fallback || intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
    },
    [intl, locale],
  );
}
