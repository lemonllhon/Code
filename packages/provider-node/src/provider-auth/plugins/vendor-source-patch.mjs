/** 补丁只匹配已固定源码；上游变化必须重新审查，不能静默跳过。 */
export function replacePinned(source, original, replacement) {
  if (source.split(original).length !== 2)
    throw new Error("Pinned provider compatibility patch no longer matches");
  return source.replace(original, () => replacement);
}

export function replacePinnedRegion(source, start, end, replacement) {
  const from = source.indexOf(start);
  const until = source.indexOf(end, from + start.length);
  if (from < 0 || until < 0 || source.indexOf(start, from + start.length) >= 0)
    throw new Error("Pinned provider compatibility region no longer matches");
  return source.slice(0, from) + replacement + source.slice(until);
}
