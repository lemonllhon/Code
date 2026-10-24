export interface SidePaneToolWindowOwner {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string | null;
  projectName: string;
  sessionTitle: string;
}

export function toolWindowWorkspaceKey(owner: SidePaneToolWindowOwner) {
  return owner.workspaceIdentity?.trim() || owner.workspacePath;
}

export function toolWindowScopeKey(owner: SidePaneToolWindowOwner) {
  return JSON.stringify([toolWindowWorkspaceKey(owner), owner.sessionId]);
}

export function sidePaneToolWindowKey(workspaceKey: string, tabId: string) {
  return JSON.stringify([workspaceKey, tabId]);
}
