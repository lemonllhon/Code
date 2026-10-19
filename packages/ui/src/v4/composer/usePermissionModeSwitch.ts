import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CommandAck } from "@lcode/shared/lcode-protocol-v4";
import type { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";

type PermissionMode = "build" | "edit" | "yolo";

/** Runtime 拥有已提交权限；此 hook 只管理当前 scope 的请求和 ACK 后的草稿同步。 */
export function usePermissionModeSwitch(params: {
  scopeKey: string;
  owner: unknown;
  pendingRef: RefObject<boolean>;
  barrier: ReturnType<typeof createConfigCommandBarrier>;
  commit: ((mode: PermissionMode) => Promise<CommandAck | null>) | null;
  onCommitted: (mode: PermissionMode) => void;
  onError: (error: unknown) => void;
}) {
  const { scopeKey, owner, pendingRef, barrier, commit, onCommitted, onError } = params;
  const binding = useMemo(() => ({ scopeKey, owner }), [scopeKey, owner]);
  const currentBinding = useRef(binding);
  const mounted = useRef(false);
  const [pendingBinding, setPendingBinding] = useState<typeof binding | null>(null);
  if (currentBinding.current !== binding) {
    currentBinding.current = binding;
    pendingRef.current = false;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const switchMode = useCallback(
    (mode: PermissionMode) => {
      if (pendingRef.current) return;
      if (!commit) {
        onCommitted(mode);
        return;
      }
      // 发送先冻结 Submission 再进入异步屏障；同一事件循环内也必须挡住旧权限提交。
      pendingRef.current = true;
      setPendingBinding(binding);
      const isCurrent = () => mounted.current && currentBinding.current === binding;
      void barrier
        .enqueue(async () => {
          if (!isCurrent()) return;
          const ack = await commit(mode);
          if (!isCurrent()) return;
          if (!ack || !["accepted", "noop", "duplicate"].includes(ack.status)) {
            throw new Error(`Permission switch failed: ${ack?.status ?? "missing-ack"}`);
          }
          onCommitted(mode);
        })
        .catch((error: unknown) => {
          if (isCurrent()) onError(error);
        })
        .finally(() => {
          if (!isCurrent()) return;
          pendingRef.current = false;
          setPendingBinding(null);
        });
    },
    [pendingRef, commit, onCommitted, binding, barrier, onError],
  );
  return { switchMode, pending: pendingBinding === binding };
}
