import { readModelFailureDisposition } from "@lcode/contracts";

export function canRecoverCompactModelFailure(error: unknown): boolean {
  // Adapter 已终止或耗尽物理预算时，换 transport / 外层摘要都不能重新获得预算。
  const disposition = readModelFailureDisposition(error);
  return disposition !== "terminal" && disposition !== "exhausted";
}
