import type { ReviewPreviewFile } from "@/lib/codeViewer.js";
import { reviewPreviewFileKey } from "./commitReviewFiles.js";

export interface ReviewFileTreeNode {
  id: string;
  label: string;
  kind: "changes" | "untracked" | "folder" | "file";
  children: ReviewFileTreeNode[];
  file?: ReviewPreviewFile;
}

/** 只投影有界的当前页；树不能引入页外文件或另存一份提交范围。 */
export function buildReviewFileTree(
  files: readonly ReviewPreviewFile[],
  untracked: ReadonlySet<string> = new Set(),
): ReviewFileTreeNode[] {
  const roots: ReviewFileTreeNode[] = [];
  for (const file of files) {
    const kind = untracked.has(file.path) ? "untracked" : "changes";
    let parent = roots.find((node) => node.kind === kind);
    if (!parent) {
      parent = { id: kind, label: kind, kind, children: [] };
      roots.push(parent);
    }
    const segments = file.path.replaceAll("\\", "/").split("/");
    for (const segment of segments.slice(0, -1)) {
      const id: string = parent.id + "/" + segment;
      let folder: ReviewFileTreeNode | undefined = parent.children.find((node) => node.id === id);
      if (!folder) {
        folder = { id, label: segment, kind: "folder", children: [] };
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({
      id: reviewPreviewFileKey(file),
      label: segments.at(-1) ?? file.path,
      kind: "file",
      children: [],
      file,
    });
  }
  return roots.sort((a, b) => Number(a.kind === "untracked") - Number(b.kind === "untracked"));
}

export function reviewTreePaths(node: ReviewFileTreeNode): string[] {
  return [...new Set(node.file ? [node.file.path] : node.children.flatMap(reviewTreePaths))];
}

export function reviewTreeCheckState(
  node: ReviewFileTreeNode,
  excluded: ReadonlySet<string>,
): boolean | "indeterminate" {
  const paths = reviewTreePaths(node);
  const included = paths.filter((path) => !excluded.has(path)).length;
  return included === 0 ? false : included === paths.length ? true : "indeterminate";
}
