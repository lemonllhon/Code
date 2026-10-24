import { createContext, useContext, useEffect, type ReactNode } from "react";

export type ToolWindowMoveGuard = { prepare: () => Promise<boolean>; reconnect?: () => void };
const Context = createContext<Set<ToolWindowMoveGuard> | null>(null);

export function ToolWindowMoveProvider({
  guards,
  children,
}: {
  guards: Set<ToolWindowMoveGuard>;
  children: ReactNode;
}) {
  return <Context.Provider value={guards}>{children}</Context.Provider>;
}

/** webview 跨 document 前先获得 Main 的 teardown ACK，禁止绕过 guest 生命周期。 */
export function useBeforeToolWindowMove(prepare: () => Promise<boolean>, reconnect?: () => void) {
  const guards = useContext(Context);
  useEffect(() => {
    const guard = { prepare, reconnect };
    guards?.add(guard);
    return () => {
      guards?.delete(guard);
    };
  }, [prepare, reconnect, guards]);
}
