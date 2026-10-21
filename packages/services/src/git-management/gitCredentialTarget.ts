import type { GitAccountProvider } from "./gitProviderEvidence.js";

export type GitCredentialTarget = {
  serverUrl: string;
  username: string;
  provider?: GitAccountProvider;
};
export function parseGitCredentialTarget(
  target: string,
  account: string,
  namespaces = ["git"],
): GitCredentialTarget | null {
  target = target.replace(/^LegacyGeneric:target=/i, "");
  const prefix = namespaces.find((name) =>
    target.toLowerCase().startsWith(name.toLowerCase() + ":"),
  );
  if (prefix) target = target.slice(prefix.length + 1);
  else return null;
  try {
    const url = new URL(target);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const embedded = decodeURIComponent(url.username);
    const username = account || embedded;
    // GCM 会把目标 URL 中邮箱用户名的 @ 转成 _；优先保留凭据真实 UserName。
    if (embedded && account && embedded !== account && embedded !== account.replace(/@/g, "_"))
      return null;
    if (
      !username.trim() ||
      username.length > 512 ||
      [...username].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      /^(?:gh[pousr]_|github_pat_|glpat-)/.test(username)
    )
      return null;
    url.username = "";
    return { serverUrl: url.origin + url.pathname.replace(/\/+$/, ""), username };
  } catch {
    return null;
  }
}
