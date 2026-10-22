import type { CommandAck } from "@lcode/shared/lcode-protocol-v4";

export function createCommandFailure(
  ack: Pick<CommandAck, "reasonCode" | "message">,
  fallback: string,
): Error {
  // Host 已提供真正的失败原因；只保留 reasonCode 会把缺接口等可诊断错误全部显示为通用发送失败。
  const details = [ack.reasonCode?.trim(), ack.message?.trim()].filter((value): value is string =>
    Boolean(value),
  );
  return new Error([...new Set(details)].join(": ") || fallback);
}
