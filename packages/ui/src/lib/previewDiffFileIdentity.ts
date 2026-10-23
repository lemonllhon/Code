export function createPreviewDiffFiles(source: {
  path?: string;
  title: string;
  beforeContent: string;
  afterContent: string;
}) {
  const name = source.path ?? source.title;
  // 首尾采样键会把中段的等长编辑当成同一文件；使用完整内容，避免展示旧 AST。
  return {
    oldFile: {
      name,
      contents: source.beforeContent,
      cacheKey: JSON.stringify(["old", name, source.beforeContent]),
    },
    newFile: {
      name,
      contents: source.afterContent,
      cacheKey: JSON.stringify(["new", name, source.afterContent]),
    },
  };
}
