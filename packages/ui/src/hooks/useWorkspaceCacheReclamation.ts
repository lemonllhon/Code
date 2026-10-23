import { useEffect, useRef } from "react";
import { useLCodeSessionStore } from "../store/lcodeSessionStore.js";
import { reclaimWorkspaceDisplayCaches } from "../store/lcodeSessionCacheReclamation.js";

/** 标签只提供可见性事实，显示缓存仍通过 Session store 的单一写入入口回收。 */
export function useWorkspaceCacheReclamation(
  workspaces: ReadonlyArray<{ workspacePath: string; workspaceIdentity?: string }>,
) {
  const previous = useRef(new Set<string>());
  const closed = useRef(new Set<string>());
  const signature = JSON.stringify(
    workspaces.map((scope) => scope.workspaceIdentity?.trim() || scope.workspacePath).sort(),
  );
  useEffect(() => {
    const openKeys = new Set<string>(JSON.parse(signature));
    for (const key of previous.current) if (!openKeys.has(key)) closed.current.add(key);
    for (const key of openKeys) closed.current.delete(key);
    previous.current = openKeys;
    const reclaim = () => {
      const current = useLCodeSessionStore.getState().workspaces;
      // 仅处理本窗口明确关闭过的标签；启动恢复尚未建标签时不误清其它消费者。
      const protectedKeys = new Set(Object.keys(current).filter((key) => !closed.current.has(key)));
      const next = reclaimWorkspaceDisplayCaches(current, protectedKeys);
      if (next !== current) useLCodeSessionStore.setState({ workspaces: next });
    };
    reclaim();
    // 在途配置结清后再回收，不用定时器猜测后台操作完成时刻。
    return useLCodeSessionStore.subscribe(reclaim);
  }, [signature]);
}
