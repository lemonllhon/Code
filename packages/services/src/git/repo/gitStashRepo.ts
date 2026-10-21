import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  GitRepositoryRequest,
  GitStashSelection,
  GitStashSnapshot,
  GitStashPreview,
  GitStashEntry,
  GitStashSavePreviewRequest,
} from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import { fingerprint, type GitWorkspaceSafety } from "./gitWorkspaceSafety.js";

export interface StashRecords {
  cwd: string;
  revision: string;
  entries: GitStashEntry[];
  log: Buffer;
  logPath: string;
  head: string | null;
}
export class GitStashRepo {
  constructor(readonly safety: GitWorkspaceSafety) {}
  async records(workspacePath: string): Promise<StashRecords> {
    const cwd = await this.safety.state.root(workspacePath);
    const logPath = resolve(
      cwd,
      (await this.safety.git(cwd, ["rev-parse", "--git-path", "logs/refs/stash"])).trim(),
    );
    let log = Buffer.alloc(0);
    try {
      if ((await lstat(logPath)).size > 16 * 1024 ** 2)
        throw new GitNetworkError("stash-list-too-large");
      log = await readFile(logPath);
      if (log.length > 16 * 1024 ** 2) throw new GitNetworkError("stash-list-too-large");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const head =
      (
        await this.safety.git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"], [0, 1])
      ).trim() || null;
    const entries: GitStashEntry[] = [];
    if (head) {
      const parts = (
        await this.safety.git(cwd, [
          "reflog",
          "show",
          "-z",
          "--format=%H%x00%gd%x00%gs%x00%ct",
          "refs/stash",
        ])
      ).split("\0");
      if (parts.at(-1) === "") parts.pop();
      if (parts.length % 4) throw new GitNetworkError("invalid-stash");
      for (let index = 0; index < parts.length; index += 4)
        entries.push({
          oid: parts[index]!,
          selector: parts[index + 1]!,
          subject: parts[index + 2]!,
          timestamp: Number(parts[index + 3]),
        });
    }
    // reflog 在另一 worktree 写入时不能返回混合列表；OID 本身不是列表版本。
    const after = await readFile(logPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return Buffer.alloc(0);
    });
    const headAfter =
      (
        await this.safety.git(cwd, ["rev-parse", "--verify", "--quiet", "refs/stash"], [0, 1])
      ).trim() || null;
    if (!log.equals(after) || head !== headAfter) throw new GitNetworkError("stale-preview");
    if (entries.length && entries[0]!.oid !== head) throw new GitNetworkError("invalid-stash");
    return {
      cwd,
      revision: fingerprint([head, createHash("sha256").update(log).digest("hex"), entries]),
      entries,
      log,
      logPath,
      head,
    };
  }
  async snapshot(scope: GitRepositoryRequest): Promise<GitStashSnapshot> {
    const records = await this.records(scope.workspacePath);
    const reservation = await this.safety.reservation(scope);
    return { revision: records.revision, entries: records.entries, ...reservation };
  }
  async previewSave(params: GitStashSavePreviewRequest) {
    const records = await this.records(params.workspacePath);
    const expectedState = await this.safety.state.capture(params.workspacePath);
    const raw = await this.safety.git(records.cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      params.includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
    ]);
    const entries = raw.split("\0").filter(Boolean),
      files = new Set<string>();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.length < 4 || entry[2] !== " ") throw new GitNetworkError("invalid-index");
      files.add(entry.slice(3));
      if (/[RC]/.test(entry.slice(0, 2))) {
        const original = entries[++index];
        if (!original) throw new GitNetworkError("invalid-index");
        files.add(original);
      }
    }
    await this.safety.assertCurrent(params.workspacePath, expectedState);
    if ((await this.records(params.workspacePath)).revision !== records.revision)
      throw new GitNetworkError("stale-preview");
    return {
      root: records.cwd,
      files: [...files].sort(),
      expectedState,
      revision: records.revision,
    };
  }
  async selection(params: GitStashSelection) {
    const records = await this.records(params.workspacePath);
    if (records.revision !== params.expectedRevision) throw new GitNetworkError("stale-preview");
    if (!records.entries.some((item) => item.oid === params.oid))
      throw new GitNetworkError("missing-stash");
    return records;
  }
  async trees(cwd: string, oid: string) {
    const parents = (await this.safety.git(cwd, ["rev-list", "--parents", "-n", "1", oid]))
      .trim()
      .split(" ");
    if (parents[0] !== oid || parents.length < 3 || parents.length > 4)
      throw new GitNetworkError("invalid-stash");
    return { base: parents[1]!, index: parents[2]!, untracked: parents[3] ?? null };
  }
  async preview(params: GitStashSelection): Promise<GitStashPreview> {
    const records = await this.selection(params);
    const trees = await this.trees(records.cwd, params.oid);
    const sections: GitStashPreview["sections"] = [];
    for (const [source, before, after] of [
      ["staged", trees.base, trees.index],
      ["unstaged", trees.index, params.oid],
      ["untracked", null, trees.untracked],
    ] as const) {
      if (!after) continue;
      const result = await this.safety.command.run({
        cwd: records.cwd,
        args: [
          "-c",
          "core.quotePath=false",
          ...(before
            ? ["diff", "--no-ext-diff", "--no-textconv", "--no-color", before, after, "--"]
            : [
                "show",
                "--format=",
                "--root",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                after,
                "--",
              ]),
        ],
        maxOutputBytes: 256 * 1024,
      });
      if (result.timedOut || (result.exitCode !== 0 && !result.outputTruncated))
        throw new GitNetworkError("git-command-failed");
      sections.push({ source, patch: result.stdout, truncated: result.outputTruncated });
    }
    if ((await this.records(params.workspacePath)).revision !== records.revision)
      throw new GitNetworkError("stale-preview");
    return { oid: params.oid, revision: records.revision, sections };
  }
}
