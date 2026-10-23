/** 物理完成由 transport/body 确认；Runner 的 release 不是上游已经停止的证据。 */
export function observeApiKeyResponse(
  response: Response,
  signal: AbortSignal,
  end: (success: boolean) => void,
): Response {
  const reader = response.body?.getReader();
  if (!reader) {
    end(response.ok);
    return response;
  }
  let done = false;
  let cancellation: Promise<void> | undefined;
  const finish = (success: boolean) => {
    if (done) return;
    done = true;
    signal.removeEventListener("abort", abort);
    end(success);
  };
  // cancel 会先关闭 pending read，之后才等待底层取消；两者不是同一个完成信号。
  const cancelPhysical = (reason?: unknown) =>
    // cancel 拒绝时并未证明底层请求结束，不能释放共享恢复许可。
    (cancellation ??= reader.cancel(reason).then(() => finish(false)));
  const abort = () => {
    void cancelPhysical(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          // fetch 的 abort 可能先令底层流 errored，随后 cancel 拒绝；read 的真实终态
          // 仍须收尾，否则已断开的请求永久占住槽位。wrapper 写入异常不能当作该证明。
          finish(false);
          controller.error(error);
          return;
        }
        if (next.done) {
          if (!cancellation) finish(response.ok && !signal.aborted);
          controller.close();
        } else controller.enqueue(next.value);
      },
      async cancel(reason) {
        await cancelPhysical(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
