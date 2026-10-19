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
