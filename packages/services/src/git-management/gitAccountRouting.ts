import {
  gitAuthenticationUrl,
  peers,
  hints,
  bindingKey,
  findBinding,
  matchesBinding,
  type Repository,
} from "./gitAuthenticationTarget.js";
export { gitAuthenticationUrl } from "./gitAuthenticationTarget.js";
import {
  resetSystemGitCredentialAttempts,
  type createSystemGitCredentialGuard,
  type SystemGitCredentialAttempt,
  type GitCredentialLifecycle,
} from "./gitSystemCredentialGuard.js";
import { createHash, randomUUID } from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import { z } from "zod";
import { isAbsolute, win32, resolve as resolvePath } from "node:path";
import {
  gitRepositoryAuthenticationRequestSchema,
  gitRepositoryAccountBindingSchema,
  type GitAccount,
  type GitAccountInput,
  type GitRepositoryAuthenticationRequest,
  type GitRepositoryAuthentication,
  type GitCredentialResult,
  replaceRemoteWorkspaceIdentityPath,
} from "@lcode/shared";
import type { GitCommandProvider } from "../git/providers/gitCommandProvider.js";
import type { DetectedGitAccount } from "./gitDetection.js";

export const gitStoredAccountBindingSchema = z
  .object({
    scope: z.string(),
    root: z.string(),
    url: z.string(),
    id: z.string().uuid().nullable(),
    revision: z.string().uuid().nullable(),
  })
  .strict()
  .refine((value) => Boolean(value.id) === Boolean(value.revision));
type Account = Omit<GitAccount, "hasToken"> & { token?: string };
type Binding = z.infer<typeof gitStoredAccountBindingSchema>;
type Profile = {
  revision: string;
  accounts: Account[];
  bindings: Binding[];
  systemCredentialAttempts: SystemGitCredentialAttempt[];
};
type Auth = { account: Account | null; secret?: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (url: string) => {
  try {
    return gitAuthenticationUrl(url).href.replace(/\/$/, "");
  } catch {
    if (url.includes("://")) throw new Error("git-account-invalid-url");
    return url;
  }
};
const authenticationTarget = (value: string) => {
  const url = gitAuthenticationUrl(value);
  if (url.protocol !== "ssh:") url.username = "";
  return url.href;
};
export function gitAccountMatches(
  account: Pick<GitAccountInput, "serverUrl" | "username">,
  value: string,
) {
  try {
    const target = gitAuthenticationUrl(value),
      server = gitAuthenticationUrl(account.serverUrl);
    const prefix = server.pathname.replace(/\/$/, "");
    return (
      target.protocol === server.protocol &&
      target.host === server.host &&
      (!target.username || decodeURIComponent(target.username) === account.username) &&
      (target.pathname === prefix || target.pathname.startsWith(prefix + "/"))
    );
  } catch {
    return false;
  }
}

// 中文依据：任何一端改了用户名提示，Fetch 也必须核对整个共享目标，不能继续静默使用旧账号。
const matchesTarget = (
  account: Pick<GitAccountInput, "serverUrl" | "username">,
  repo: Repository,
  url: string,
) =>
  peers(repo, url)
    .filter((u) => bindingKey(repo, u) === bindingKey(repo, url))
    .every((u) => gitAccountMatches(account, u));

export function createGitAccountRouting(options: {
  read(): Promise<Profile>;
  update(expected: string, edit: (profile: Profile) => void): Promise<void>;
  detect(): Promise<{ entries: DetectedGitAccount[] }>;
  authenticate(url: string, reference: { id: string; revision?: string }): Promise<Auth>;
  command: GitCommandProvider;
  systemCredentials: ReturnType<typeof createSystemGitCredentialGuard>;
}) {
  const git = async (cwd: string, args: string[], allowed = [0]) => {
    const result = await options.command.run({ cwd, args });
    if (!allowed.includes(result.exitCode ?? -1))
      throw new Error("git-account-repository-unavailable");
    return result.stdout.trim();
  };
  const repository = async (request: GitRepositoryAuthenticationRequest) => {
    const top = await git(request.workspacePath, ["rev-parse", "--show-toplevel"], [0, 128]);
    const root = await realpath(
      top || (await git(request.workspacePath, ["rev-parse", "--absolute-git-dir"])),
    );
    // 中文依据：Agent 在 linked worktree 执行时也必须复用原仓库的 URL 选择，不能回落旧全局账号。
    const bindingRoot = await realpath(
      resolvePath(root, await git(root, ["rev-parse", "--git-common-dir"])),
    );
    const names = (await git(root, ["remote"])).split(/\r?\n/).filter(Boolean);
    const remotes = await Promise.all(
      names.map(async (name) => ({
        name,
        urls: [
          ...new Set(
            (
              await Promise.all([
                git(root, ["remote", "get-url", "--all", "--", name]),
                git(root, ["remote", "get-url", "--push", "--all", "--", name]),
              ])
            )
              .flatMap((v) => v.split(/\r?\n/))
              .filter(Boolean)
              .map(canonical),
          ),
        ],
      })),
    );
    const identity = request.workspaceIdentity?.trim();
    return {
      root,
      bindingRoot,
      remotes,
      scope: identity
        ? (replaceRemoteWorkspaceIdentityPath(identity, bindingRoot) ?? identity)
        : bindingRoot,
    };
  };
  const choices = async (profile: Profile, discover = true) => {
    const detected = (discover ? (await options.detect()).entries : []).filter(
      ({ account }) =>
        !profile.accounts.some(
          (a) =>
            a.serverUrl === account.serverUrl &&
            a.username === account.username &&
            a.auth === account.auth &&
            a.privateKeyPath === account.privateKeyPath,
        ),
    );
    return [
      ...profile.accounts.map((account) => ({
        key: `saved:${account.id}:${account.revision}`,
        account,
      })),
      ...detected.map((entry) => ({
        key: `detected:${entry.metadata.candidateId}`,
        account: entry.account,
      })),
    ];
  };
  const view = async (request: GitRepositoryAuthenticationRequest, contextOnly = false) => {
    const repo = await repository(request),
      profile = await options.read(),
      legacyId = await git(repo.root, ["config", "--local", "--get", "lcode.accountId"], [0, 1]);
    const selectionFor = (url: string): string | null => {
      const state = findBinding(profile, repo, url);
      if (state.conflict) return "conflict";
      if (state.binding?.id) return `saved:${state.binding.id}:${state.binding.revision}`;
      // 自动 tombstone 阻止 legacy origin 复活；选择依据与执行/菜单共用同一条规则。
      const legacy =
        !state.binding && repo.remotes.some((r) => r.name === "origin" && r.urls.includes(url))
          ? legacyId
          : "";
      return legacy
        ? `saved:${legacy}:${profile.accounts.find((a) => a.id === legacy)?.revision ?? "missing"}`
        : null;
    };
    // 已有显式绑定的模型背景读取曾每步扫描系统账号，增加发送前等待；候选不会改变
    // 显式选择。只跳过这类只读摘要的发现，实时 profile/remote、自动匹配和执行鉴权仍照常。
    const available = await choices(
      profile,
      !contextOnly ||
        repo.remotes.some((remote) => remote.urls.some((url) => selectionFor(url) === null)),
    );
    const snapshot: GitRepositoryAuthentication = {
      revision: hash([profile.revision, repo, legacyId]),
      choices: available.map(({ key, account }) => ({
        key,
        name: account.name,
        username: account.username,
        serverUrl: account.serverUrl,
        auth: account.auth,
        provider: account.provider,
      })),
      remotes: repo.remotes.map((remote) => ({
        ...remote,
        urls: remote.urls.map((url) => {
          const selection = selectionFor(url);
          return {
            url,
            selection,
            ...(hints(repo, url).length === 1 ? { usernameHint: hints(repo, url)[0] } : {}),
            stale: Boolean(
              selection &&
              !available.some((c) => c.key === selection && matchesTarget(c.account, repo, url)),
            ),
          };
        }),
      })),
    };
    return { repo, profile, available, snapshot };
  };
  const automatic = async (profile: Profile, value: string): Promise<Auth> => {
    const matches = (await choices(profile)).filter((c) => gitAccountMatches(c.account, value));
    if (matches.length > 1) throw new Error("git-account-selection-required");
    const selected = matches[0];
    if (!selected) return { account: null };
    if (selected.key.startsWith("saved:")) {
      const account = selected.account as Account;
      return options.authenticate(authenticationTarget(value), {
        id: account.id,
        revision: account.revision,
      });
    }
    return {
      account: {
        ...selected.account,
        id: randomUUID(),
        revision: randomUUID(),
        privateKeyPath: selected.account.privateKeyPath ?? "",
      },
      secret: selected.account.token,
    };
  };
  const resolve = async (
    request: GitRepositoryAuthenticationRequest,
    value: string,
    allowUnconfigured = false,
  ): Promise<Auth> => {
    if (
      isAbsolute(value) ||
      win32.isAbsolute(value) ||
      (!value.includes("://") && !/^(?:[^@/:]+@)?[^/:]+:.+$/.test(value))
    ) {
      const legacy = await git(
        request.workspacePath,
        ["config", "--local", "--get", "lcode.accountId"],
        [0, 1],
      );
      if (legacy) return options.authenticate(value, { id: legacy });
      return { account: null };
    }
    const target = gitAuthenticationUrl(value);
    if (!["http:", "https:", "ssh:"].includes(target.protocol)) return { account: null };
    const profile = await options.read(),
      url = canonical(value);
    let repo: Awaited<ReturnType<typeof repository>>;
    try {
      repo = await repository(request);
    } catch (error) {
      if (allowUnconfigured) {
        const probe = await options.command.run({
          cwd: request.workspacePath,
          args: ["rev-parse", "--git-dir"],
          env: { LC_ALL: "C" },
        });
        // 中文依据：只有 Git 明确确认不存在仓库才允许克隆认证；配置损坏和失效路径不能放宽绑定。
        if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr))
          return automatic(profile, value);
      }
      throw error;
    }
    if (!repo.remotes.some((remote) => remote.urls.includes(url)))
      throw new Error("git-account-remote-changed");
    const state = findBinding(profile, repo, url);
    if (state.conflict) throw new Error("git-account-binding-conflict");
    const binding = state.binding;
    // 中文依据：远端 URL 绑定优先，旧的仓库全局 ID 不能让另一个 remote 串用身份。
    const legacy =
      binding || !repo.remotes.some((r) => r.name === "origin" && r.urls.includes(url))
        ? ""
        : await git(repo.root, ["config", "--local", "--get", "lcode.accountId"], [0, 1]);
    if (binding?.id || legacy) {
      const auth = await options.authenticate(
        authenticationTarget(value),
        binding?.id ? { id: binding.id, revision: binding.revision ?? undefined } : { id: legacy },
      );
      if (!auth.account || !matchesTarget(auth.account, repo, value))
        throw new Error("git-account-binding-stale");
      return auth;
    }
    // 中文依据：Fetch/Push 同一目标只有一个显式用户名时应一致；不从仓库 owner 或 GCM 默认项猜账号。
    const usernames = hints(repo, value);
    if (
      !target.username &&
      usernames.length === 1 &&
      ["http:", "https:"].includes(target.protocol)
    ) {
      target.username = usernames[0]!;
      return automatic(profile, target.href);
    }
    return automatic(profile, value);
  };
  return {
    async getRepositoryContextSnapshot(input: GitRepositoryAuthenticationRequest) {
      return (await view(gitRepositoryAuthenticationRequestSchema.parse(input), true)).snapshot;
    },
    async getRepositoryAuthentication(input: GitRepositoryAuthenticationRequest) {
      return (await view(gitRepositoryAuthenticationRequestSchema.parse(input))).snapshot;
    },
    async bindRepositoryAuthentication(input: unknown, isActive: () => boolean = () => true) {
      const request = gitRepositoryAccountBindingSchema.parse(input),
        current = await view(request),
        url = canonical(request.url);
      if (current.snapshot.revision !== request.expectedRevision)
        throw new Error("git-account-binding-conflict");
      if (!current.repo.remotes.some((remote) => remote.urls.includes(url)))
        throw new Error("git-account-remote-changed");
      const selected = current.available.find((c) => c.key === request.selection);
      if (request.selection && (!selected || !matchesTarget(selected.account, current.repo, url)))
        throw new Error("git-account-selection-unavailable");
      await options.update(current.profile.revision, (profile) => {
        if (!isActive()) throw new Error("git-account-scope-unavailable");
        profile.bindings = profile.bindings.filter((b) => !matchesBinding(b, current.repo, url));
        if (selected) {
          let account = selected.account as Account;
          if (selected.key.startsWith("detected:")) {
            account = {
              ...account,
              id: randomUUID(),
              revision: randomUUID(),
              privateKeyPath: account.privateKeyPath ?? "",
            };
            profile.accounts.push(account);
          }
          profile.bindings.push({
            root: current.repo.bindingRoot,
            scope: current.repo.scope,
            url: bindingKey(current.repo, url),
            id: account.id,
            revision: account.revision,
          });
          if (account.auth === "system")
            resetSystemGitCredentialAttempts(profile, account.serverUrl, account.username);
        } else {
          // 中文依据：显式恢复自动匹配需要留下作用域标记，不能复活克隆时写下的旧全局 ID。
          profile.bindings.push({
            root: current.repo.bindingRoot,
            scope: current.repo.scope,
            url: bindingKey(current.repo, url),
            id: null,
            revision: null,
          });
        }
      });
      return (await view(request)).snapshot;
    },
    resolve,
    async credential(
      request: GitRepositoryAuthenticationRequest,
      value: string,
      lifecycle: GitCredentialLifecycle = {},
    ): Promise<GitCredentialResult> {
      const url = gitAuthenticationUrl(value);
      if (lifecycle.operation === "approve")
        return options.systemCredentials.approve(
          value,
          decodeURIComponent(url.username),
          lifecycle.attemptId ?? "",
        );
      const auth = lifecycle.authentication
        ? await options.authenticate(value, lifecycle.authentication)
        : await resolve(request, value, true);
      if (url.protocol === "ssh:") {
        const path = auth.account?.privateKeyPath ?? "";
        if (path && (!isAbsolute(path) || !(await lstat(path).catch(() => null))?.isFile()))
          throw new Error("git-account-ssh-key-unavailable");
        return {
          kind: "ssh",
          username: auth.account?.username ?? decodeURIComponent(url.username),
          privateKeyPath: path,
        };
      }
      if (auth.secret && auth.account)
        return {
          kind: "http",
          username:
            auth.account.auth === "oauth" && auth.account.provider === "gitlab"
              ? "oauth2"
              : auth.account.username,
          password: auth.secret,
        };
      return options.systemCredentials.read(
        options.command,
        request.workspacePath,
        value,
        auth.account?.username,
      );
    },
  };
}
