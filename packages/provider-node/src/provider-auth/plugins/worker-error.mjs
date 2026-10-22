import { readAuthorizationDiagnostic } from "../authorization-diagnostics.ts";
import { ToolSchemaCompatibilityError } from "@lcode/provider";
/** worker 边界只传安全授权事实；cause 不跨线程发送。 */
export function workerFailure(error, scope) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    // 仅转发本地编译器的固定契约，不能让插件任意对象扩大跨线程错误内容。
    ...(error instanceof ToolSchemaCompatibilityError
      ? { code: error.code, context: error.context }
      : {}),
    ...(error?.signIn ? { signIn: error.signIn } : {}),
    ...(scope?.authorization
      ? {
          diagnostic: scope.authorizationDiagnostic?.code
            ? scope.authorizationDiagnostic
            : readAuthorizationDiagnostic(
                error,
                scope.authorizationDiagnostic?.phase ?? "exchange",
              ),
        }
      : {}),
  };
}
