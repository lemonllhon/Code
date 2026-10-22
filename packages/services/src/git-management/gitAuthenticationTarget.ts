export function gitAuthenticationUrl(value: string): URL {
  const scp = value.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
  const result = new URL(
    value.includes("://")
      ? value
      : scp
        ? `ssh://${scp[1] ? scp[1] + "@" : ""}${scp[2]}/${scp[3]}`
        : value,
  );
  if (result.password || result.search || result.hash) throw new Error("git-account-invalid-url");
  return result;
}
export type Repository = {
  scope: string;
  bindingRoot: string;
  remotes: { name: string; urls: string[] }[];
};
export const targetKey = (value: string) => {
  try {
    const url = gitAuthenticationUrl(value);
    if (["http:", "https:"].includes(url.protocol)) url.username = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return value;
  }
};
export const peers = (repo: Repository, value: string) =>
  repo.remotes.flatMap((r) => r.urls).filter((u) => targetKey(u) === targetKey(value));
export const hints = (repo: Repository, value: string) => [
  ...new Set(
    peers(repo, value).flatMap((u) => {
      try {
        const url = gitAuthenticationUrl(u);
        return url.username ? [decodeURIComponent(url.username)] : [];
      } catch {
        return [];
      }
    }),
  ),
];
export const bindingKey = (repo: Repository, value: string) =>
  hints(repo, value).length > 1 ? value : targetKey(value);
export const matchesBinding = (
  b: { scope: string; root: string; url: string },
  repo: Repository,
  url: string,
) =>
  b.scope === repo.scope &&
  b.root === repo.bindingRoot &&
  bindingKey(repo, b.url) === bindingKey(repo, url);
