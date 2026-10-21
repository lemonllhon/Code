export interface HistoryTreeNode {
  key: string;
  path: string;
  name: string;
  status?: string;
  count: number;
  children: HistoryTreeNode[];
}
export function historyTree(files: readonly { path: string; status: string }[]) {
  const roots: HistoryTreeNode[] = [],
    dirs = new Map<string, HistoryTreeNode>();
  for (const file of files) {
    const parts = file.path.split("/");
    let children = roots;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let dir = dirs.get(path);
      if (!dir) {
        dir = { key: `d:${path}`, path, name: parts[i]!, count: 0, children: [] };
        dirs.set(path, dir);
        children.push(dir);
      }
      dir.count++;
      children = dir.children;
    }
    children.push({ ...file, key: `f:${file.path}`, name: parts.at(-1)!, count: 1, children: [] });
  }
  const sort = (nodes: HistoryTreeNode[]) => {
    nodes.sort(
      (a, b) =>
        Number(Boolean(a.status)) - Number(Boolean(b.status)) || a.name.localeCompare(b.name),
    );
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}
