import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitNetworkOperation } from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import type { GitWorkspaceSafety } from "./gitWorkspaceSafety.js";

/** 原生状态只读校验，供整合操作与 E1 人工解决共享；不接管业务状态。 */
export class GitIntegrationState {
  constructor(readonly safety: GitWorkspaceSafety) {}
  async readNative(root: string, name: string) {
    const dir = (await this.safety.git(root, ["rev-parse", "--absolute-git-dir"])).trim();
    const path = join(dir, name),
      info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new GitNetworkError("unsupported-integration");
    return (await readFile(path, "utf8")).trim();
  }
  async replay(root: string, head: string, target: string) {
    const commits = (
      await this.safety.git(root, [
        "rev-list",
        "--reverse",
        "--max-count=1025",
        `${target}..${head}`,
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (
      commits.length > 1024 ||
      (
        await this.safety.git(root, [
          "rev-list",
          "--max-count=1",
          "--min-parents=2",
          `${target}..${head}`,
        ])
      ).trim()
    )
      throw new GitNetworkError("unsupported-rebase-topology");
    return commits;
  }
  async matches(
    root: string,
    operation: GitNetworkOperation,
    mode: string | null,
    head: string | null,
    branch: string | null,
  ) {
    const original = operation.integration;
    if (!original || mode !== original.mode) return false;
    if (operation.after && head !== operation.after) return false;
    if (
      (await this.readNative(root, "MERGE_AUTOSTASH")) !== null ||
      (await this.readNative(root, "rebase-merge/autostash")) !== null
    )
      return false;
    if (mode === "merge")
      return (
        head === original.head &&
        branch === original.branch &&
        (await this.readNative(root, "MERGE_HEAD")) === original.target &&
        (await this.readNative(root, "ORIG_HEAD")) === original.head
      );
    if (
      (mode === "cherry-pick" || mode === "revert") &&
      original.targets &&
      original.targets.length > 1
    ) {
      if (
        branch !== original.branch ||
        !head ||
        (await this.readNative(root, "sequencer/head")) !== original.head
      )
        return false;
      const lines =
        (await this.readNative(root, "sequencer/todo"))?.split("\n").filter(Boolean) ?? [];
      const remaining: string[] = [];
      for (const line of lines) {
        const match = /^(pick|revert) ([a-f0-9]{7,64})(?:\s|$)/.exec(line);
        if (!match || match[1] !== (mode === "cherry-pick" ? "pick" : "revert")) return false;
        remaining.push(match[2]!);
      }
      const completed = original.targets.length - remaining.length;
      if (
        !remaining.length ||
        completed < 0 ||
        !remaining.every((hash, index) => original.targets![completed + index]!.startsWith(hash))
      )
        return false;
      const active = await this.readNative(
        root,
        mode === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD",
      );
      if (active !== original.targets[completed]) return false;
      return this.completed(
        root,
        { ...original, targets: original.targets.slice(0, completed) },
        head,
        completed,
      );
    }
    if (mode === "cherry-pick" || mode === "revert")
      return (
        head === original.head &&
        branch === original.branch &&
        (await this.readNative(
          root,
          mode === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD",
        )) === original.target &&
        (await this.readNative(
          root,
          mode === "cherry-pick" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD",
        )) === null &&
        (await this.readNative(root, "MERGE_HEAD")) === null &&
        (await this.readNative(root, "sequencer/head")) === null &&
        (await this.readNative(root, "sequencer/todo")) === null
      );
    if (
      (await this.readNative(root, "rebase-merge/orig-head")) !== original.head ||
      (await this.readNative(root, "rebase-merge/head-name")) !== `refs/heads/${original.branch}` ||
      (await this.readNative(root, "rebase-merge/onto")) !== original.target ||
      branch !== null
    )
      return false;
    if (
      (
        await this.safety.git(root, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `refs/heads/${original.branch}`,
        ])
      ).trim() !== original.head
    )
      return false;
    // 外部修改 todo 不能借 Continue 执行 exec/reset/其它分支；只允许原线性范围的 pick。
    const replay = await this.replay(root, original.head, original.target);
    const planned: string[] = [];
    for (const file of ["done", "git-rebase-todo"]) {
      const raw = await this.readNative(root, `rebase-merge/${file}`);
      if (raw === null && file === "git-rebase-todo") return false;
      for (const line of (raw ?? "")
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"))) {
        const match = /^pick ([a-f0-9]{7,64})(?:\s|$)/.exec(line);
        if (!match || !replay.some((oid) => oid.startsWith(match[1]!))) return false;
        planned.push(match[1]!);
      }
    }
    return (
      replay.length === planned.length &&
      replay.every((oid, index) => oid.startsWith(planned[index]!))
    );
  }
  async completed(
    root: string,
    integration: NonNullable<GitNetworkOperation["integration"]>,
    head: string,
    count = integration.targets?.length ?? 1,
  ) {
    let cursor = head;
    for (let i = 0; i < count; i++) {
      const parents = (await this.safety.git(root, ["rev-list", "--parents", "-n", "1", cursor]))
        .trim()
        .split(" ")
        .slice(1);
      if (parents.length !== 1) return false;
      cursor = parents[0]!;
    }
    return cursor === integration.head;
  }
}
