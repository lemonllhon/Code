import { useGitBranchSwitcher } from "@/hooks/useGitBranchSwitcher.js";

export function BranchProbe({
  root,
  identity,
  refresh,
}: {
  root: string;
  identity?: string;
  refresh: () => void;
}) {
  const branch = useGitBranchSwitcher({
    workspacePath: root,
    workspaceIdentity: identity,
    workspaceRemoteSessionId: identity ? "fixture-remote" : undefined,
    currentBranchName: "main",
    headRefType: "branch",
    onRefreshGit: refresh,
  });
  return (
    <div className="fixed bottom-0 right-0 bg-background">
      <output data-testid="branch-probe-step">{branch.switchAssistStep ?? "none"}</output>
      <button
        data-testid="branch-probe-switch"
        disabled={branch.mutationPending}
        onClick={() => void branch.switchBranch("topic")}
      >
        Switch
      </button>
      <button
        data-testid="branch-probe-commit"
        disabled={branch.mutationPending || !branch.switchAssistState}
        onClick={() => void branch.commitAndSwitchBranch()}
      >
        Commit and switch
      </button>
    </div>
  );
}
