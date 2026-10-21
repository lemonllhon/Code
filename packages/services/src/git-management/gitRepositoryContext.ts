import type { GitAgentRepositoryContext, GitRepositoryAuthentication } from "@lcode/shared";
import { gitAccountMatches, gitAuthenticationUrl } from "./gitAccountRouting.js";

/** 只投影公开账号元信息，不能调用认证/刷新端口或把候选列表交给模型。 */
export function projectGitRepositoryContext(
  workspacePath: string,
  snapshot: GitRepositoryAuthentication,
): GitAgentRepositoryContext {
  const remotes: GitAgentRepositoryContext["remotes"] = [];
  let total = 0;
  for (const remote of snapshot.remotes) {
    for (const target of remote.urls) {
      total++;
      if (remotes.length === 32) continue;
      let url = target.url,
        network = false;
      try {
        const parsed = gitAuthenticationUrl(url);
        network =
          !/^(?:[A-Za-z]:[/\\]|[/\\])/.test(url) &&
          ["http:", "https:", "ssh:"].includes(parsed.protocol);
        if (network) {
          parsed.username = "";
          url = parsed.href.replace(/\/$/, "");
        }
      } catch {
        // 无效网络 URL 不能被当成本地路径回显，避免异常配置把凭据带入模型。
        if (url.includes("://")) throw new Error("git-context-unavailable");
      }
      const matches = snapshot.choices.filter((c) => gitAccountMatches(c, target.url));
      const selected = target.selection
        ? matches.find((c) => c.key === target.selection)
        : matches.length === 1
          ? matches[0]
          : undefined;
      const stale = target.stale || Boolean(target.selection && !selected);
      const status = !network
        ? "not-applicable"
        : stale
          ? "stale"
          : target.selection
            ? "selected"
            : matches.length > 1
              ? "selection-required"
              : selected
                ? "automatic"
                : "system-default";
      remotes.push({
        name: remote.name,
        url,
        authentication: {
          status,
          ...(network && !stale && selected
            ? {
                account: {
                  name: selected.name,
                  username: selected.username,
                  provider: selected.provider,
                },
              }
            : {}),
        },
      });
    }
  }
  return {
    workspacePath,
    revision: snapshot.revision,
    status: "available",
    remotes,
    partial: total > 32,
  };
}
