const INVALID = "无法完整读取 Git 暂存区语义或格式，不能确认发布。";
// Git 持久条目标志：assume-valid、intent-to-add、skip-worktree；其余 debug 位包含内存/缓存状态。
const PERSISTENT_FLAGS = 0x60008000;

export function parseGitPublishIndex(output: string): { entries: string[]; paths: string[] } {
  const header = /([A-Za-z]) ([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])\t([^\0]+)\0/y;
  const stat =
    /  ctime: -?\d+:\d+\r?\n  mtime: -?\d+:\d+\r?\n  dev: -?\d+\tino: -?\d+\r?\n  uid: -?\d+\tgid: -?\d+\r?\n  size: -?\d+\tflags: ([0-9a-f]{1,8})\r?\n/y;
  const entries: string[] = [];
  const paths: string[] = [];
  let offset = 0;
  while (offset < output.length) {
    header.lastIndex = offset;
    const entry = header.exec(output);
    if (!entry) throw new Error(INVALID);
    stat.lastIndex = header.lastIndex;
    const cache = stat.exec(output);
    if (!cache) throw new Error(INVALID);
    if (entry[4] !== "0") throw new Error("暂存区存在冲突，不能确认发布。");
    if (entry[2] === "160000") throw new Error("发布快照暂不支持子模块，请使用普通 Git 操作。");
    const flags = Number.parseInt(cache[1]!, 16);
    if (flags & 0x80000000) throw new Error(INVALID);
    // 根因：status 刷新 stat/split 缓存会改写 index 字节。只冻结逻辑条目及持久位，不能漏掉同 OID 的 intent-to-add。
    entries.push(
      JSON.stringify([entry[5], entry[2], entry[3], entry[4], flags & PERSISTENT_FLAGS]),
    );
    paths.push(entry[5]!);
    offset = stat.lastIndex;
  }
  return { entries, paths };
}
