import type { GitHistoryCandidates, GitRepositoryRequest } from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import { fingerprint } from "./gitWorkspaceSafety.js";
import type { GitHistoryRepo } from "./gitHistoryRepo.js";

export class GitHistoryCandidatesRepo {
  constructor(private readonly history: GitHistoryRepo) {}
  async read(scope: GitRepositoryRequest): Promise<GitHistoryCandidates> {
    const root = await this.history.safety.state.root(scope.workspacePath);
    const refs = await this.history.refs(root);
    const raw = await this.history.git(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objecttype)%00%(*objecttype)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    const candidates: GitHistoryCandidates["refs"] = refs.head
      ? [{ value: refs.head, label: "HEAD", kind: "head" }]
      : [];
    for (const line of raw.split("\n").filter(Boolean)) {
      const [name, type, peeled] = line.trim().split("\0");
      if (type !== "commit" && peeled !== "commit") continue;
      candidates.push({
        value: name!,
        label: name!.replace(/^refs\/(?:heads|remotes|tags)\//, ""),
        kind: name!.startsWith("refs/heads/")
          ? "branch"
          : name!.startsWith("refs/remotes/")
            ? "remote"
            : "tag",
      });
    }
    const cells =
      refs.head || refs.raw
        ? (
            await this.history.git(root, [
              "log",
              ...(refs.head ? [refs.head] : []),
              "--branches",
              "--remotes",
              "--tags",
              "--date-order",
              "--max-count=2001",
              "--format=%an%x00%ae%x00",
              "--",
            ])
          ).split("\0")
        : [];
    const authors = new Map<string, GitHistoryCandidates["authors"][number]>();
    let count = 0;
    while (cells.length > 1) {
      const name = cells.shift()!.replace(/^\r?\n/, ""),
        email = cells.shift()!;
      if (++count > 2000) break;
      const value = (email || name).trim();
      if (value && !authors.has(value.toLowerCase()))
        authors.set(value.toLowerCase(), { name, email, value });
    }
    if (fingerprint(refs) !== fingerprint(await this.history.refs(root)))
      throw new GitNetworkError("stale-history");
    return {
      revision: fingerprint([root, refs]),
      refs: candidates.slice(0, 500),
      authors: [...authors.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200),
      refsTruncated: candidates.length > 500,
      authorsTruncated: authors.size > 200,
      historyTruncated: count > 2000,
    };
  }
}
