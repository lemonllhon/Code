import type { ProviderAccountCheckinResult } from "@lcode/shared";

/** 这些失败需要账号/本机环境变化；定时请求本身不能消除阻塞。 */
export function checkinRequiresAction(result?: ProviderAccountCheckinResult): boolean {
  return (
    result?.outcome === "failed" &&
    (result.error === "dependency_required" || result.error === "sign_in_required")
  );
}
