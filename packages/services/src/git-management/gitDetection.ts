import { readdir, lstat } from "node:fs/promises";
import { join, dirname, isAbsolute, matchesGlob, normalize } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { GitAccountInput, GitDetectedAccount } from "@lcode/shared";
import { gitAccountInputSchema } from "@lcode/shared";
import type { GitCommandProvider } from "../git/providers/gitCommandProvider.js";
import { gitCliConfigSources, readGitDetectionFile as textFile } from "./gitDetectionFiles.js";
import { detectSshPublicKeys } from "./gitSshKeyDetection.js";
import { detectSystemGitHubAccounts } from "./gitSystemAccountDetection.js";
import {
  inferGitProvider as inferDetectedGitProvider,
  gitProviderForUrl,
  readGitProviderEvidence,
  type GitProviderEvidence,
} from "./gitProviderEvidence.js";
import { detectSystemGitCredentials } from "./gitSystemCredentialDetection.js";
import type { GitCredentialMetadataRunner } from "./gitCredentialMetadataProcess.js";
import type { GitSystemCredentialSource } from "@lcode/shared";

export type DetectedGitAccount = { metadata: GitDetectedAccount; account: GitAccountInput };
export function inferGitProvider(host: string): GitAccountInput["provider"] {
  return inferDetectedGitProvider(host);
}
const expand = (path: string, home: string) =>
  path.replace(/^~(?=$|[/\\])/, home).replace(/%d/g, home);
export async function detectGitAccounts(
  home: string,
  configHome = join(home, ".config"),
  environment: NodeJS.ProcessEnv = {},
  options: {
    platform?: NodeJS.Platform;
    command?: GitCommandProvider | null;
    metadataRunner?: GitCredentialMetadataRunner | null;
    evidence?: GitProviderEvidence[];
  } = {},
) {
  const entries: DetectedGitAccount[] = [],
    warnings: string[] = [],
    privateKeyPaths: string[] = [];
  const referencedKeys = new Set<string>();
  const mapping = options.command
    ? await readGitProviderEvidence(options.command, home)
    : { evidence: [], namespaces: ["git"] };
  const evidence = [...(options.evidence ?? []), ...mapping.evidence];
  const add = (source: string, account: GitAccountInput) => {
    const parsed = gitAccountInputSchema.safeParse(account);
    if (!parsed.success) {
      warnings.push("account-config-invalid");
      return;
    }
    account = parsed.data;
    if (account.auth !== "ssh") {
      const url = new URL(account.serverUrl);
      account = { ...account, serverUrl: url.origin + url.pathname.replace(/\/+$/, "") };
    }
    if (entries.length >= 200) return;
    // 同服务器不同用户名必须保留；同账号的 CLI/GCM/系统来源只保留优先来源，避免重复导入。
    if (
      entries.some(
        (e) =>
          e.account.serverUrl === account.serverUrl &&
          e.account.username === account.username &&
          e.account.privateKeyPath === account.privateKeyPath,
      )
    )
      return;
    const candidateId = createHash("sha256")
      .update(
        JSON.stringify([
          source,
          account.provider,
          account.serverUrl,
          account.username,
          account.auth,
          account.privateKeyPath,
        ]),
      )
      .digest("hex");
    if (entries.some((e) => e.metadata.candidateId === candidateId)) return;
    const { token: _token, id: _id, ...metadata } = account;
    entries.push({
      metadata: {
        ...metadata,
        privateKeyPath: metadata.privateKeyPath ?? "",
        candidateId,
        source,
        canImport: true,
      },
      account,
    });
  };
  const sshDirectory = join(home, ".ssh");
  for (const name of await readdir(sshDirectory).catch(() => [])) {
    if (!/^id_[\w-]+$/.test(name)) continue;
    const path = join(sshDirectory, name),
      stat = await lstat(path).catch(() => null);
    if (stat?.isFile() && privateKeyPaths.length < 200) privateKeyPaths.push(path);
  }
  // 只解析静态元信息；不能用 ssh -G，它可能执行用户配置中的 Match exec。
  const visited = new Set<string>();
  const scan = async (path: string, depth = 0) => {
    if (depth > 8 || visited.size >= 64 || visited.has(path)) return;
    visited.add(path);
    let content: string;
    try {
      content = await textFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push("ssh-config-unreadable");
      return;
    }
    let aliases: string[] = [],
      user = "git",
      key = "",
      hostname = "";
    const flush = () => {
      for (const alias of aliases)
        add("SSH config", {
          name: alias,
          provider: inferGitProvider(hostname || alias),
          serverUrl: `ssh://${encodeURIComponent(user)}@${alias}`,
          username: user,
          auth: "ssh",
          privateKeyPath: key,
        });
    };
    for (const line of content.split(/\r?\n/)) {
      const match = line.trim().match(/^(\w+)\s*(?:=\s*|\s+)(.*?)\s*(?:#.*)?$/);
      if (!match) continue;
      const command = match[1]!.toLowerCase(),
        value = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
      if (command === "host") {
        flush();
        aliases = value.split(/\s+/).filter((v) => /^[a-z0-9][a-z0-9.-]*$/i.test(v));
        user = "git";
        key = "";
        hostname = "";
      } else if (command === "match") {
        flush();
        aliases = [];
      } else if (command === "user" && aliases.length) user = value;
      else if (command === "hostname" && aliases.length && !hostname) hostname = value;
      else if (command === "identityfile" && aliases.length) {
        const expanded = expand(value, home);
        // Windows 的 ~/ 展开可能混用分隔符，先规范化才能与默认密钥路径正确去重。
        if (!expanded.includes("%")) {
          const path = isAbsolute(expanded) ? normalize(expanded) : join(home, expanded);
          if (!key) key = path;
          if (referencedKeys.size < 200) referencedKeys.add(path);
        }
      } else if (command === "include") {
        for (const item of value.split(/\s+/)) {
          const expanded = expand(item, home),
            target = isAbsolute(expanded) ? expanded : join(sshDirectory, expanded);
          if (/[*?[]/.test(target)) {
            for (const file of await readdir(dirname(target)).catch(() => [])) {
              const candidate = join(dirname(target), file);
              if (matchesGlob(candidate, target)) await scan(candidate, depth + 1);
            }
          } else await scan(target, depth + 1);
        }
      }
    }
    flush();
  };
  await scan(join(sshDirectory, "config"));
  const sources = gitCliConfigSources(
    home,
    configHome,
    environment,
    options.platform ?? process.platform,
  );
  for (const source of sources) {
    let data: unknown;
    try {
      data = parse(await textFile(source.path), { maxAliasCount: 50 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`${source.provider}-config-unreadable`);
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const config = data as Record<string, unknown>;
    const hosts =
      source.provider === "github" ? config : ((config.hosts ?? {}) as Record<string, unknown>);
    if (hosts && typeof hosts === "object")
      for (const [host, raw] of Object.entries(hosts)) {
        // 自建服务常用单段内网主机名；合法性由统一 URL schema 判断，不能只接受带点域名。
        if (!raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        const users =
          record.users && typeof record.users === "object"
            ? Object.entries(record.users)
            : [[record.user ?? record.username, record]];
        for (const [name, value] of users) {
          const user = typeof name === "string" ? name : "";
          if (!user) continue;
          const details =
            value && typeof value === "object" ? (value as Record<string, unknown>) : {};
          // 主机级 token 属于活动用户；将它兜底给其他 users 会把两个账号错误地绑定到同一身份。
          const token =
            details.oauth_token ??
            details.token ??
            (user === (record.user ?? record.username)
              ? (record.oauth_token ?? record.token)
              : undefined);
          add(source.provider + " CLI", {
            name: `${user} · ${host}`,
            provider: source.provider,
            serverUrl: host.includes("://") ? host : `https://${host}`,
            username: user,
            auth: typeof token === "string" && token ? "token" : "system",
            privateKeyPath: "",
            ...(typeof token === "string" ? { token } : {}),
          });
        }
      }
    if (source.provider === "gitea" && Array.isArray(config.logins))
      for (const raw of config.logins) {
        if (!raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        if (typeof record.url !== "string" || typeof record.user !== "string") continue;
        add("tea CLI", {
          name: typeof record.name === "string" ? record.name : record.user,
          provider: "gitea",
          serverUrl: record.url,
          username: record.user,
          auth: typeof record.token === "string" ? "token" : "system",
          privateKeyPath: "",
          ...(typeof record.token === "string" ? { token: record.token } : {}),
        });
      }
  }
  for (const path of new Set([
    join(home, ".git-credentials"),
    join(environment.XDG_CONFIG_HOME || configHome, "git", "credentials"),
  ])) {
    try {
      const content = await textFile(path);
      for (const line of content.split(/\r?\n/).slice(0, 2000)) {
        if (!line.trim() || line.trim().startsWith("#")) continue;
        try {
          const url = new URL(line.trim());
          if (
            !["https:", "http:"].includes(url.protocol) ||
            !url.username ||
            url.search ||
            url.hash
          )
            continue;
          const username = decodeURIComponent(url.username),
            token = decodeURIComponent(url.password);
          url.username = "";
          url.password = "";
          add("Git credential file", {
            name: `${username} · ${url.host}`,
            provider: inferGitProvider(url.hostname),
            serverUrl: url.href.replace(/\/$/, ""),
            username,
            auth: token ? "token" : "system",
            privateKeyPath: "",
            ...(token ? { token } : {}),
          });
        } catch {
          warnings.push("credential-config-invalid");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push("credential-config-unreadable");
    }
  }
  if (options.command) {
    const system = await detectSystemGitHubAccounts(
      options.command,
      home,
      entries
        .filter(
          (e) => e.account.provider === "github" && e.account.serverUrl.startsWith("https://"),
        )
        .map((e) => e.account.serverUrl),
    );
    system.accounts.forEach((account) => add("Git Credential Manager", account));
    if (system.failed) warnings.push("system-accounts-unavailable");
  }
  const systemCredentialSources: GitSystemCredentialSource[] = [];
  if (options.metadataRunner) {
    const result = await detectSystemGitCredentials({
      platform: options.platform ?? process.platform,
      runner: options.metadataRunner,
      namespaces: mapping.namespaces,
      evidence: [
        ...evidence,
        ...entries.map((e) => ({ serverUrl: e.account.serverUrl, provider: e.account.provider })),
      ],
    });
    systemCredentialSources.push(result.source);
    const hints = [
      ...evidence,
      ...entries.map((e) => ({ serverUrl: e.account.serverUrl, provider: e.account.provider })),
    ];
    for (const account of result.accounts)
      add(result.source.source, {
        ...account,
        name: `${account.username} · ${new URL(account.serverUrl).host}`,
        provider: gitProviderForUrl(account.serverUrl, hints),
        auth: "system",
        privateKeyPath: "",
      });
  }
  for (const path of new Set([
    ...referencedKeys,
    ...entries.filter((e) => e.account.auth === "ssh").map((e) => e.account.privateKeyPath),
  ])) {
    if (
      path &&
      !privateKeyPaths.includes(path) &&
      privateKeyPaths.length < 200 &&
      (await lstat(path).catch(() => null))?.isFile()
    )
      privateKeyPaths.push(path);
  }
  const sshKeys = await detectSshPublicKeys(privateKeyPaths);
  return {
    entries,
    warnings: [...new Set(warnings)],
    privateKeyPaths,
    sshKeys,
    sshDirectory,
    systemCredentialSources,
  };
}
