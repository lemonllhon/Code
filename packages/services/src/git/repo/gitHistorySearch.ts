import type { GitRepositoryRequest } from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import type { GitHistoryRepo } from "./gitHistoryRepo.js";

export class GitHistorySearch {
  constructor(private readonly history: GitHistoryRepo) {}
  async reachable(root: string, hash: string, roots: string[]) {
    return !(
      await this.history.git(root, ["rev-list", "--max-count=1", hash, "--not", ...roots, "--"])
    ).trim();
  }
  async hashes(root: string, prefix: string, roots: string[]) {
    const objects = (
      await this.history.git(root, ["rev-parse", `--disambiguate=${prefix.toLowerCase()}`])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (objects.length > 64) throw new GitNetworkError("ambiguous-history-target");
    const commits: string[] = [];
    for (const oid of objects) {
      if (
        (await this.history.git(root, ["cat-file", "-t", oid])).trim() === "commit" &&
        (await this.reachable(root, oid, roots))
      )
        commits.push(oid);
    }
    return commits;
  }
  async locate(params: GitRepositoryRequest & { target: string }) {
    const root = await this.history.safety.state.root(params.workspacePath),
      refs = await this.history.refs(root);
    const roots = [...(refs.head ? [refs.head] : []), "--branches", "--remotes", "--tags"];
    let hash: string;
    if (/^[a-f0-9]{4,64}$/i.test(params.target)) {
      const matches = await this.hashes(root, params.target, roots);
      if (matches.length !== 1)
        throw new GitNetworkError(
          matches.length ? "ambiguous-history-target" : "missing-history-target",
        );
      hash = matches[0]!;
    } else
      hash = (
        await this.history.git(root, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${params.target}^{commit}`,
        ])
      ).trim();
    if (!(await this.reachable(root, hash, roots)))
      throw new GitNetworkError("missing-history-target");
    if (JSON.stringify(refs) !== JSON.stringify(await this.history.refs(root)))
      throw new GitNetworkError("stale-history");
    return { hash };
  }
}
export const escapeHistoryPattern = (value: string) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
