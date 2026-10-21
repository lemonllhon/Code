export type GitCommitDialogSource = "automatic" | "composer" | "toolbar" | "network";
export interface GitCommitDialogAttempt {
  id: number;
  source: GitCommitDialogSource;
  draftKey?: string;
  visible: boolean;
  engaged: boolean;
}

/** 审核请求不是显示成功；结束/卸载时递增代次，拒绝迟到的加载与 AI 结果。 */
export class GitCommitDialogLifecycle {
  private epoch = 0;
  private disposed = false;
  private attemptedDraftKeys = new Set<string>();
  private consumedDraftKeys = new Set<string>();
  current: GitCommitDialogAttempt | null = null;

  activate(): void {
    this.disposed = false;
  }

  ignoreDraft(key: string): void {
    this.attemptedDraftKeys.add(key);
  }

  canAutoOpen(key: string): boolean {
    return !this.disposed && !this.current?.engaged && !this.attemptedDraftKeys.has(key);
  }

  engage(): void {
    if (this.current) this.current.engaged = true;
  }

  begin(source: GitCommitDialogSource, draftKey?: string): number {
    this.disposed = false;
    if (draftKey) this.attemptedDraftKeys.add(draftKey);
    // 安装版复现：进入远端的只读初始化不能消费自动草稿；人工审核/发布才接管该 attempt。
    this.current = {
      id: ++this.epoch,
      source,
      ...(draftKey ? { draftKey } : {}),
      visible: false,
      engaged: source !== "network",
    };
    return this.epoch;
  }

  isCurrent(id: number): boolean {
    return !this.disposed && this.current?.id === id;
  }

  shown(id: number): boolean {
    if (!this.isCurrent(id) || this.current!.visible) return false;
    this.current!.visible = true;
    if (this.current!.draftKey) this.consumedDraftKeys.add(this.current!.draftKey);
    return true;
  }

  consumed(key: string): boolean {
    return this.consumedDraftKeys.has(key);
  }

  close(userDismissed = false): void {
    if (userDismissed && this.current?.draftKey) this.consumedDraftKeys.add(this.current.draftKey);
    ++this.epoch;
    this.current = null;
  }

  dispose(): void {
    this.close();
    this.disposed = true;
  }
}
