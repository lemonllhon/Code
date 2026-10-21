import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useCommitReviewNavigationStore } from "@/store/commitReviewNavigationStore.js";

// 来源树拥有执行服务上下文；这里只迁移 DOM 位置，不能在右侧复制审核控制器。
export function ReviewPanePortal({
  scope,
  open,
  children,
}: {
  scope: string;
  open: boolean;
  children: (visible: boolean) => ReactNode;
}) {
  const host = useCommitReviewNavigationStore((state) => state.paneHosts[scope]);
  const navigation = useCommitReviewNavigationStore((state) => state.paneNavigation[scope]);
  useEffect(() => {
    if (open) navigation?.open();
    // 导航注册完成时补一次打开；隐藏和切工具不会改变注册 token，不能因迟到结果反复展开。
  }, [open, navigation]);
  return host ? createPortal(children(open && host.visible), host.element) : null;
}
