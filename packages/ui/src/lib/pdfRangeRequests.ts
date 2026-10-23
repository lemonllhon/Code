/** 当前 PDF 文档的在途读取 owner；完成即释放，不缓存二进制内容。 */
export class PdfRangeRequests {
  private readonly pending = new Map<string, Promise<void>>();
  private aborted = false;
  private generation = 0;

  constructor(
    private readonly read: (begin: number, length: number) => Promise<Uint8Array>,
    private readonly deliver: (begin: number, chunk: Uint8Array) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  request(begin: number, end: number): void {
    if (this.aborted) return;
    const key = `${begin}:${end}`;
    if (this.pending.has(key)) return;
    const generation = this.generation;
    // 相同范围并发请求曾重复发起 RPC；只合并本代在途请求，失败后仍可重试。
    const request = (async () => {
      try {
        const chunk = await this.read(begin, end - begin);
        if (!this.aborted && this.generation === generation) this.deliver(begin, chunk);
      } catch (error) {
        if (!this.aborted && this.generation === generation)
          this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    this.pending.set(key, request);
    void request.finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
  }

  abort(): void {
    // PDFDataRangeTransport 的默认 abort 不拒绝迟到回包，旧文档必须自行终结投递。
    this.aborted = true;
    this.generation++;
    this.pending.clear();
  }
}
