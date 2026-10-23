const PARAGRAPH_BREAK = /\n[\t ]*\n/gu;
const OMITTED_PREFIX = "…\n";
const OMITTED_SUFFIX = "\n…";
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/** 只选择原文片段，不概括事实；元数据命中没有正文锚点时维持原前缀行为。 */
export function selectMemoryExcerpt(
  content: string,
  matchedTerms: readonly string[],
  maximumLength: number,
): string {
  const limit = Math.max(0, Math.trunc(maximumLength));
  if (content.length <= limit) return content;
  if (!limit) return "";
  const terms = [...new Set(matchedTerms.map(normalize).filter(Boolean))];
  const focused = selectParagraphNeighborhoods(content, terms, limit);
  if (focused !== undefined) return focused;
  let best = { start: 0, end: 0, score: 0 };
  let start = 0;
  const breaks = [...content.matchAll(PARAGRAPH_BREAK)];
  const boundaries = [...breaks.map((entry) => entry.index), content.length];
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index]!;
    const text = normalize(content.slice(start, boundary));
    const score = terms.reduce((sum, term) => sum + Number(text.includes(term)), 0);
    if (score > best.score) best = { start, end: boundary, score };
    const separator = breaks[index];
    start = boundary + (separator?.[0].length ?? 0);
  }
  if (!best.score || limit <= OMITTED_PREFIX.length + OMITTED_SUFFIX.length)
    return safeSlice(content, 0, limit);
  const budget = limit - OMITTED_PREFIX.length - OMITTED_SUFFIX.length;
  // 原因：整篇相关但固定取前缀会丢掉后部事实；围绕命中段落保留相邻的否定和例外。
  const block = content.slice(best.start, best.end);
  const anchor = best.start + (block.length <= budget ? block.length / 2 : firstHit(block, terms));
  const from = Math.max(0, Math.min(content.length - budget, Math.floor(anchor - budget / 2)));
  const to = Math.min(content.length, from + budget);
  return `${from > 0 ? OMITTED_PREFIX : ""}${safeSlice(content, from, to)}${to < content.length ? OMITTED_SUFFIX : ""}`;
}

/** 只拼接有来源的原文段落；不生成摘要，不把相隔的限制条件揉成新事实。 */
function selectParagraphNeighborhoods(
  content: string,
  terms: readonly string[],
  limit: number,
): string | undefined {
  const blocks: Array<{ start: number; end: number; score: number }> = [];
  let start = 0;
  for (const match of content.matchAll(PARAGRAPH_BREAK)) {
    blocks.push({ start, end: match.index, score: 0 });
    start = match.index + match[0].length;
  }
  blocks.push({ start, end: content.length, score: 0 });
  for (const block of blocks) {
    const text = normalize(content.slice(block.start, block.end));
    block.score = terms.filter((term) => text.includes(term)).length;
  }
  const hits = blocks
    .map((block, index) => ({ ...block, index }))
    .filter((block) => block.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start);
  const selected = new Set<number>();
  const render = (indices: ReadonlySet<number>) => {
    const ordered = [...indices].sort((a, b) => a - b);
    let text = ordered[0] === 0 ? "" : OMITTED_PREFIX;
    let previous = -1;
    for (const index of ordered) {
      if (previous >= 0) text += index === previous + 1 ? "\n\n" : "\n\n…\n\n";
      const block = blocks[index]!;
      text += content.slice(block.start, block.end);
      previous = index;
    }
    if (previous < blocks.length - 1) text += OMITTED_SUFFIX;
    return text;
  };
  for (const hit of hits) {
    const next = new Set(selected);
    // 原因：固定窗口填满无关前文会掩盖后部证据；保留命中段的前后限制与最近章节标题。
    for (
      let index = Math.max(0, hit.index - 1);
      index <= Math.min(blocks.length - 1, hit.index + 1);
      index++
    )
      next.add(index);
    for (let index = hit.index; index >= 0; index--) {
      const block = blocks[index]!;
      if (/^#{1,6}\s/u.test(content.slice(block.start, block.end))) {
        next.add(index);
        break;
      }
    }
    // 简短开篇可能规定整篇适用范围，不能因它没有查询词而丢掉。
    if (blocks[0]!.end <= 200) next.add(0);
    if (render(next).length <= limit) {
      for (const index of next) selected.add(index);
    } else if (!selected.size) {
      // 最佳命中段过长时仍围绕它截取，不能退而只展示容易放下的次要命中。
      return undefined;
    }
  }
  return selected.size ? render(selected) : undefined;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function firstHit(value: string, terms: readonly string[]): number {
  let normalized = "";
  const offsets: number[] = [];
  // 逐 code point 归一化无法合成 e + accent，长段落会丢失正确命中偏移。
  // 按字素簇归一化，保留组合字符与原文偏移。
  for (const { segment, index: offset } of GRAPHEME_SEGMENTER.segment(value)) {
    const part = normalize(segment);
    normalized += part;
    for (let index = 0; index < part.length; index++) offsets.push(offset);
  }
  const hits = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0);
  return hits.length ? (offsets[Math.min(...hits)] ?? 0) : 0;
}

function safeSlice(text: string, start: number, end: number): string {
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start++;
  if (end > start && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return text.slice(start, end);
}
