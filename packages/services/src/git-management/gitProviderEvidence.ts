import type { GitAccountInput } from "@lcode/shared";
import type { GitCommandProvider } from "../git/providers/gitCommandProvider.js";
export type GitAccountProvider = GitAccountInput["provider"];
export type GitProviderEvidence = { serverUrl: string; provider: GitAccountProvider };
export function inferGitProvider(host: string): GitAccountProvider {
  host = host.toLowerCase();
  if (host === "github.com" || /(^|\.)github\./.test(host)) return "github";
  if (/gitlab/i.test(host)) return "gitlab";
  if (/gitea|forgejo|codeberg/i.test(host)) return "gitea";
  return "server";
}
export function gitProviderForUrl(
  serverUrl: string,
  evidence: GitProviderEvidence[],
): GitAccountProvider {
  const target = new URL(serverUrl);
  const matching = evidence
    .filter((hint) => {
      try {
        const url = new URL(hint.serverUrl);
        const prefix = url.pathname.replace(/\/+$/, "");
        return (
          target.origin === url.origin &&
          (target.pathname === prefix || target.pathname.startsWith(prefix + "/"))
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.serverUrl.length - a.serverUrl.length);
  return matching[0]?.provider ?? inferGitProvider(target.hostname);
}
export async function readGitProviderEvidence(command: GitCommandProvider, home: string) {
  const evidence: GitProviderEvidence[] = [],
    namespaces = ["git"];
  try {
    const result = await command.run({
      cwd: home,
      args: ["config", "--get-regexp", "^credential\\..*\\.provider$|^credential\\.namespace$"],
      timeoutMs: 4000,
      maxOutputBytes: 65536,
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated)
      return { evidence, namespaces };
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;
      if (match[1] === "credential.namespace" && /^[\w.-]{1,64}$/.test(match[2]!)) {
        namespaces.push(match[2]!);
        continue;
      }
      const scope = match[1]!.match(/^credential\.(.+)\.provider$/i)?.[1];
      const value = match[2]!.toLowerCase();
      const provider = (
        {
          github: "github",
          gitlab: "gitlab",
          gitea: "gitea",
          forgejo: "gitea",
          bitbucket: "server",
          generic: "server",
        } as Record<string, GitAccountProvider>
      )[value];
      if (!scope || !provider) continue;
      const url = new URL(scope.includes("://") ? scope : "https://" + scope);
      if (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        evidence.push({ serverUrl: url.origin + url.pathname.replace(/\/+$/, ""), provider });
    }
  } catch {
    /* Git 配置映射不可用不阻断系统凭据的通用分类。 */
  }
  return { evidence, namespaces: [...new Set(namespaces)] };
}
