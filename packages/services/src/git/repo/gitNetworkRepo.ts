import { createHash } from "node:crypto";
import type {
  GitNetworkSnapshot,
  GitRemoteMutationRequest,
  GitTrackingRequest,
  GitFetchRequest,
  GitNetworkOperation,
} from "@lcode/shared";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import type { GitCliRepo } from "./gitCliTypes.js";
import { GitPublishStateReader } from "./gitPublishState.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";
import { GitNetworkError } from "../gitNetworkJournal.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const lines = (text: string) => text.trimEnd().split(/\r?\n/).filter(Boolean);
type Effect = Partial<GitNetworkOperation>;

export class GitNetworkRepo {
  readonly state: GitPublishStateReader;
  constructor(
    private readonly repo: GitCliRepo,
    private readonly command: GitCommandProvider,
  ) {
    this.state = new GitPublishStateReader(repo, command);
  }
  private async git(cwd: string, args: string[], allowed = [0]) {
    const result = await this.command.run({ cwd, args, maxOutputBytes: 32 * 1024 ** 2 });
    if (result.orphaned) {
      const writes =
        (args[0] === "remote" && ["add", "rename", "remove"].includes(args[1] ?? "")) ||
        (args[0] === "config" && args.includes("--local"));
      throw new GitNetworkError(writes ? "writer-unsettled" : "git-command-failed");
    }
    ensureGitCommandSucceeded("git network", result, allowed);
    return result.stdout;
  }
  private async config(cwd: string, key: string) {
    return (await this.git(cwd, ["config", "--null", "--get-all", key], [0, 1]))
      .split("\0")
      .filter(Boolean);
  }
  async snapshot(workspacePath: string): Promise<GitNetworkSnapshot> {
    const cwd = await this.state.root(workspacePath);
    const [config, refs, symbolic, names] = await Promise.all([
      this.git(cwd, ["config", "--null", "--list", "--show-origin"]),
      this.git(cwd, [
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(upstream)",
        "refs/heads/",
        "refs/remotes/",
      ]),
      this.git(cwd, ["symbolic-ref", "--quiet", "HEAD"], [0, 1]),
      this.git(cwd, ["remote"]),
    ]);
    const branch = symbolic.trim().startsWith("refs/heads/") ? symbolic.trim().slice(11) : null;
    const branchRefs = lines(refs).map((line) => line.split("\t"));
    const branches = branchRefs
      .filter(([ref]) => ref!.startsWith("refs/heads/"))
      .map(([ref, head, upstream]) => ({
        name: ref!.slice(11),
        head: head!,
        upstream: upstream ? upstream.replace(/^refs\/remotes\//, "") : null,
      }));
    const remotes = await Promise.all(
      lines(names).map(async (name) => ({
        name,
        fetchUrls: await this.config(cwd, `remote.${name}.url`),
        pushUrls: await this.config(cwd, `remote.${name}.pushurl`),
      })),
    );
    const remoteBranches = branchRefs.flatMap(([ref, head]) => {
      const remote = remotes.find(({ name }) => ref!.startsWith(`refs/remotes/${name}/`));
      return remote && !ref!.endsWith("/HEAD")
        ? [
            {
              remote: remote.name,
              branch: ref!.slice(`refs/remotes/${remote.name}/`.length),
              head: head!,
            },
          ]
        : [];
    });
    const headResult = await this.command.run({
      cwd,
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
    });
    ensureGitCommandSucceeded("git network HEAD", headResult, [0, 128]);
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    if (!head) {
      if (!branch) throw new GitNetworkError("invalid-head");
      await this.git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], [1]);
    }
    const current = branches.find((item) => item.name === branch);
    // upstream atom 在引用被删除时为空，仍从 config 保留可诊断的跟踪关系。
    const upstreamRemote = branch
      ? (await this.config(cwd, `branch.${branch}.remote`))[0]
      : undefined;
    const upstreamMerge = branch
      ? (await this.config(cwd, `branch.${branch}.merge`))[0]
      : undefined;
    const upstream =
      current?.upstream ||
      (upstreamRemote && upstreamMerge?.startsWith("refs/heads/")
        ? `${upstreamRemote}/${upstreamMerge.slice(11)}`
        : null);
    const tracking = remoteBranches.find((item) => `${item.remote}/${item.branch}` === upstream);
    let ahead = 0,
      behind = 0;
    if (head && tracking) {
      const counts = (
        await this.git(cwd, ["rev-list", "--left-right", "--count", `${head}...${tracking.head}`])
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      [ahead, behind] = [counts[0]!, counts[1]!];
    }
    const [configAfter, refsAfter, symbolicAfter, headAfter] = await Promise.all([
      this.git(cwd, ["config", "--null", "--list", "--show-origin"]),
      this.git(cwd, [
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(upstream)",
        "refs/heads/",
        "refs/remotes/",
      ]),
      this.git(cwd, ["symbolic-ref", "--quiet", "HEAD"], [0, 1]),
      this.git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], head ? [0] : [128]),
    ]);
    // 外部 Git 不受应用许可控制；读取期间配置或引用变化时拒绝混合快照。
    if (
      config !== configAfter ||
      refs !== refsAfter ||
      symbolic !== symbolicAfter ||
      (head && head !== headAfter.trim())
    )
      throw new GitNetworkError("stale-preview");
    return {
      revision: digest(JSON.stringify([config, refs, symbolic, head])),
      branch,
      head,
      upstream,
      ahead,
      behind,
      remotes,
      branches,
      remoteBranches,
    };
  }
  private async assertRevision(workspacePath: string, expected: string) {
    const snapshot = await this.snapshot(workspacePath);
    if (snapshot.revision !== expected) throw new GitNetworkError("stale-preview");
    return snapshot;
  }
  private async replaceConfig(cwd: string, key: string, values: string[]) {
    await this.git(cwd, ["config", "--local", "--unset-all", key], [0, 5]);
    for (const value of values) await this.git(cwd, ["config", "--local", "--add", key, value]);
  }
  async remote(params: GitRemoteMutationRequest): Promise<Effect> {
    const snapshot = await this.assertRevision(params.workspacePath, params.expectedRevision);
    const cwd = await this.state.root(params.workspacePath);
    const exists = snapshot.remotes.some((item) => item.name === params.name);
    if ((params.action === "add") === exists)
      throw new GitNetworkError(exists ? "remote-exists" : "missing-remote");
    await this.git(cwd, ["check-ref-format", `refs/remotes/${params.name}/validation`]);
    if (params.newName) {
      await this.git(cwd, ["check-ref-format", `refs/remotes/${params.newName}/validation`]);
      if (snapshot.remotes.some((item) => item.name === params.newName))
        throw new GitNetworkError("remote-exists");
    }
    let started = false;
    try {
      if (params.action === "add") {
        started = true;
        await this.git(cwd, ["remote", "add", "--", params.name, params.fetchUrls![0]!]);
      }
      if (params.action === "add" || params.action === "edit") {
        started = true;
        await this.replaceConfig(cwd, `remote.${params.name}.url`, params.fetchUrls!);
        await this.replaceConfig(cwd, `remote.${params.name}.pushurl`, params.pushUrls ?? []);
        const after = (await this.snapshot(params.workspacePath)).remotes.find(
          (item) => item.name === params.name,
        );
        if (
          JSON.stringify(after?.fetchUrls) !== JSON.stringify(params.fetchUrls) ||
          JSON.stringify(after?.pushUrls) !== JSON.stringify(params.pushUrls ?? [])
        )
          throw new GitNetworkError("config-outcome-unknown");
      } else {
        started = true;
        await this.git(cwd, [
          "remote",
          params.action === "rename" ? "rename" : "remove",
          "--",
          params.name,
          ...(params.newName ? [params.newName] : []),
        ]);
      }
      return { status: "success" };
    } catch (error) {
      const unsettled = error instanceof GitNetworkError && error.code === "writer-unsettled";
      return {
        status: started ? "unknown" : "failed",
        code: unsettled ? "writer-unsettled" : "config-outcome-unknown",
        ...(unsettled ? { unsettled: true } : {}),
      };
    } finally {
      this.repo.invalidate(params.workspacePath);
    }
  }
  async tracking(params: GitTrackingRequest): Promise<Effect> {
    const snapshot = await this.assertRevision(params.workspacePath, params.expectedRevision);
    const cwd = await this.state.root(params.workspacePath);
    const selected = snapshot.branches.find((item) => item.name === params.branch);
    if (!selected) throw new GitNetworkError("missing-branch");
    const upstream = params.upstream;
    if (
      upstream &&
      !snapshot.remoteBranches.some(
        (item) => item.remote === upstream.remote && item.branch === upstream.branch,
      )
    )
      throw new GitNetworkError("missing-upstream");
    if (!upstream && !(await this.config(cwd, `branch.${params.branch}.remote`)).length)
      return { status: "success" };
    const result = await this.command.run({
      cwd,
      args: [
        "branch",
        ...(upstream
          ? [`--set-upstream-to=refs/remotes/${upstream.remote}/${upstream.branch}`]
          : ["--unset-upstream"]),
        "--",
        params.branch,
      ],
    });
    this.repo.invalidate(params.workspacePath);
    return {
      status:
        result.exitCode === 0 && !result.timedOut && !result.outputTruncated && !result.orphaned
          ? "success"
          : "unknown",
      ...(result.orphaned
        ? { code: "writer-unsettled", unsettled: true }
        : result.exitCode === 0
          ? {}
          : { code: "config-outcome-unknown" }),
    };
  }
  async fetch(
    params: GitFetchRequest,
    checkpoint: (effect: Effect) => Promise<void>,
  ): Promise<Effect> {
    const cwd = await this.state.root(params.workspacePath);
    const config = await this.git(cwd, ["config", "--null", "--list", "--show-origin"]);
    const snapshot = await this.assertRevision(params.workspacePath, params.expectedRevision);
    if (params.remotes.some((name) => !snapshot.remotes.some((item) => item.name === name)))
      throw new GitNetworkError("missing-remote");
    const results: NonNullable<GitNetworkOperation["results"]> = [];
    let stale = false;
    for (const remote of params.remotes) {
      // 长网络调用间外部 Git 可能改 URL；不能让下一项使用未经确认的新配置。
      if (
        stale ||
        config !== (await this.git(cwd, ["config", "--null", "--list", "--show-origin"]))
      ) {
        stale = true;
        results.push({ remote, status: "failed" });
        await checkpoint({ results: [...results] });
        continue;
      }
      try {
        const result = await this.command.run({
          cwd,
          args: [
            "-c",
            "fetch.writeCommitGraph=false",
            "fetch",
            "--atomic",
            "--refmap=",
            "--no-tags",
            "--no-prune",
            "--no-prune-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            "--no-auto-maintenance",
            "--",
            remote,
            `+refs/heads/*:refs/remotes/${remote}/*`,
          ],
          timeoutMs: 120_000,
          maxOutputBytes: 2 * 1024 ** 2,
        });
        results.push({
          remote,
          status:
            result.timedOut || result.outputTruncated || result.orphaned || result.exitCode === null
              ? "unknown"
              : result.exitCode === 0
                ? "success"
                : "failed",
        });
        if (result.orphaned) {
          await checkpoint({ results: [...results], unsettled: true });
          return { status: "unknown", results, unsettled: true, code: "writer-unsettled" };
        }
      } catch {
        results.push({ remote, status: "unknown" });
      }
      await checkpoint({ results: [...results] });
    }
    this.repo.invalidate(params.workspacePath);
    return {
      status: results.every((item) => item.status === "success")
        ? "success"
        : results.some((item) => item.status === "success")
          ? "partial"
          : results.some((item) => item.status === "unknown")
            ? "unknown"
            : "failed",
      results,
      ...(stale ? { code: "stale-preview" } : {}),
    };
  }
}
