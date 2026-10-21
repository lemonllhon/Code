import { createHash } from "node:crypto";
import type {
  GitHistoryRequest,
  GitHistoryPage,
  GitHistoryDetail,
  GitHistoryDetailRequest,
  GitHistoryFileRequest,
} from "@lcode/shared";
import { gitHistoryRequestSchema, gitHistoryDetailRequestSchema } from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import { conflictBlob } from "./gitConflictFiles.js";
import { fingerprint, type GitWorkspaceSafety } from "./gitWorkspaceSafety.js";
import { GitHistorySearch, escapeHistoryPattern } from "./gitHistorySearch.js";

export class GitHistoryRepo {
  constructor(readonly safety: GitWorkspaceSafety) {}
  async git(root: string, args: string[], maxOutputBytes = 4 * 1024 ** 2) {
    const result = await this.safety.command.run({
      cwd: root,
      args: ["--literal-pathspecs", ...args],
      maxOutputBytes,
    });
    if (
      result.exitCode !== 0 &&
      !result.timedOut &&
      !result.outputTruncated &&
      !result.orphaned &&
      args.includes("log") &&
      args.some((arg) => arg.startsWith("--grep=")) &&
      /^fatal: command line,/m.test(result.stderr)
    )
      throw new GitNetworkError("invalid-history-regex");
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || result.orphaned)
      throw new GitNetworkError("history-read-failed");
    return result.stdout;
  }
  async refs(root: string) {
    const raw = await this.git(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(*objectname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    const head = (
      await this.safety.git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], [0, 1])
    ).trim();
    const symbolic = (await this.safety.git(root, ["symbolic-ref", "-q", "HEAD"], [0, 1])).trim();
    return { raw, head, symbolic };
  }
  async page(input: GitHistoryRequest): Promise<GitHistoryPage> {
    const params = gitHistoryRequestSchema.parse(input),
      root = await this.safety.state.root(params.workspacePath),
      refs = await this.refs(root);
    const filters = {
      ref: params.ref,
      author: params.author,
      search: params.search,
      searchMode: params.searchMode,
      caseSensitive: params.caseSensitive,
      since: params.since,
      until: params.until,
    };
    const revision = fingerprint([root, refs, filters]);
    if (params.expectedRevision && params.expectedRevision !== revision)
      throw new GitNetworkError("stale-history");
    if (!refs.raw && !refs.head) return { revision, commits: [], hasMore: false };
    const ref = params.ref
      ? (
          await this.git(root, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${params.ref}^{commit}`,
          ])
        ).trim()
      : null;
    const roots = ref
      ? [ref]
      : [...(refs.head ? [refs.head] : []), "--branches", "--tags", "--remotes"];
    const hashSearch =
      params.searchMode !== "regex" && /^[a-f0-9]{4,64}$/i.test(params.search ?? "");
    const matches = hashSearch
      ? await new GitHistorySearch(this).hashes(root, params.search!, roots)
      : null;
    if (matches && !matches.length) return { revision, commits: [], hasMore: false };
    const args = [
      "log",
      ...(matches ? ["--no-walk=sorted", ...matches] : roots),
      "--topo-order",
      "--date-order",
      "--extended-regexp",
      ...(!params.caseSensitive ? ["--regexp-ignore-case"] : []),
      `--max-count=${params.limit + 1}`,
      `--skip=${params.skip}`,
      "--format=%H%x00%P%x00%an%x00%at%x00%s%x00",
      ...(params.author ? [`--author=${escapeHistoryPattern(params.author)}`] : []),
      ...(params.search && !hashSearch
        ? [
            `--grep=${params.searchMode === "regex" ? params.search : escapeHistoryPattern(params.search)}`,
          ]
        : []),
      ...(params.since ? [`--since=${params.since}`] : []),
      ...(params.until ? [`--until=${params.until}`] : []),
      "--",
    ];
    // 正则的原生语法错误与 IO/超时分开归因，读取失败不能冒充用户输入有误。
    const output = await this.git(root, args);
    const cells = output.split("\0"),
      commits: GitHistoryPage["commits"] = [];
    const decorations = new Map<string, GitHistoryPage["commits"][number]["refs"]>();
    if (refs.head) decorations.set(refs.head, [{ name: "HEAD", kind: "head" }]);
    for (const line of refs.raw.trim().split("\n").filter(Boolean)) {
      const [name, hash, peeled] = line.split("\0"),
        oid = peeled || hash!;
      const items = decorations.get(oid) ?? [];
      items.push({
        name: name!.replace(/^refs\/(?:heads|remotes|tags)\//, ""),
        kind: name!.startsWith("refs/tags/")
          ? "tag"
          : name!.startsWith("refs/remotes/")
            ? "remote"
            : "branch",
      });
      decorations.set(oid, items);
    }
    while (cells.length > 1) {
      const hash = cells.shift()!.trim(),
        parents = cells.shift()!.split(" ").filter(Boolean),
        authorName = cells.shift()!,
        timestamp = Number(cells.shift()!),
        subject = cells.shift()!;
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash) || !Number.isFinite(timestamp))
        throw new GitNetworkError("history-read-failed");
      commits.push({
        hash,
        parents,
        authorName,
        authoredAtMs: timestamp * 1000,
        subject,
        refs: decorations.get(hash) ?? [],
      });
    }
    if (fingerprint(refs) !== fingerprint(await this.refs(root)))
      throw new GitNetworkError("stale-history");
    return {
      revision,
      commits: commits.slice(0, params.limit),
      hasMore: commits.length > params.limit,
    };
  }
  async object(root: string, type: "commit" | "tag", hash: string) {
    const size = Number((await this.git(root, ["cat-file", "-s", hash])).trim());
    if (!Number.isSafeInteger(size) || size > 512 * 1024)
      throw new GitNetworkError("history-object-too-large");
    const raw = await this.git(root, ["cat-file", type, hash], 512 * 1024 + 1024),
      bytes = Buffer.from(raw);
    const oid = createHash(hash.length === 40 ? "sha1" : "sha256")
      .update(`${type} ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (bytes.length !== size || oid !== hash || raw.includes("\0"))
      throw new GitNetworkError("unsupported-history-object");
    return raw;
  }
  async detail(input: GitHistoryDetailRequest): Promise<GitHistoryDetail> {
    const params = gitHistoryDetailRequestSchema.parse(input),
      root = await this.safety.state.root(params.workspacePath),
      raw = await this.object(root, "commit", params.hash);
    const boundary = raw.indexOf("\n\n");
    if (boundary < 0) throw new GitNetworkError("unsupported-history-object");
    const headers = raw.slice(0, boundary).split("\n"),
      parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
    if (
      (parents.length && params.parent > parents.length) ||
      (!parents.length && params.parent !== 1)
    )
      throw new GitNetworkError("invalid-parent");
    const person = (key: string) => {
      const match = /^(.*) <([^<>]*)> (-?\d+) [+-]\d{4}$/.exec(
        headers.find((line) => line.startsWith(key + " "))?.slice(key.length + 1) ?? "",
      );
      if (!match) throw new GitNetworkError("unsupported-history-object");
      return { name: match[1]!, email: match[2]!, time: Number(match[3]) * 1000 };
    };
    const author = person("author"),
      committer = person("committer"),
      parentHash = parents[params.parent - 1] ?? null;
    const changes = (
      await this.git(
        root,
        parentHash
          ? [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              "--name-status",
              "-z",
              parentHash,
              params.hash,
              "--",
            ]
          : [
              "diff-tree",
              "--root",
              "--no-commit-id",
              "--no-renames",
              "-r",
              "--name-status",
              "-z",
              params.hash,
              "--",
            ],
      )
    )
      .split("\0")
      .filter(Boolean);
    const files: GitHistoryDetail["files"] = [];
    while (changes.length) {
      const status = changes.shift()!,
        path = changes.shift();
      if (!path) throw new GitNetworkError("history-read-failed");
      files.push({ status, path });
    }
    return {
      hash: params.hash,
      parents,
      parent: params.parent,
      parentHash,
      message: raw.slice(boundary + 2),
      authorName: author.name,
      authorEmail: author.email,
      authoredAtMs: author.time,
      committerName: committer.name,
      committerEmail: committer.email,
      committedAtMs: committer.time,
      files: files.slice(0, 500),
      filesTruncated: files.length > 500,
    };
  }
  async file(params: GitHistoryFileRequest) {
    // 文件请求含 path，不能整体传给 strict 的详情合同；显式投影防止合法文件读取被当作未知字段拒绝。
    const detail = await this.detail({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        hash: params.hash,
        parent: params.parent,
      }),
      root = await this.safety.state.root(params.workspacePath);
    if (!detail.files.some((file) => file.path === params.path))
      throw new GitNetworkError("missing-history-file");
    const version = async (hash: string | null) => {
      const raw = hash ? await this.git(root, ["ls-tree", "-z", hash, "--", params.path]) : "";
      if (!raw) return conflictBlob(this.safety, root, undefined);
      const match = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]+)\t/.exec(raw);
      if (!match) throw new GitNetworkError("unsupported-history-object");
      return conflictBlob(this.safety, root, { stage: 1, mode: match[1]!, oid: match[2]! });
    };
    return {
      path: params.path,
      before: await version(detail.parentHash),
      after: await version(detail.hash),
    };
  }
}
