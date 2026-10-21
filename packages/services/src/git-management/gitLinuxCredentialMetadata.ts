import type { GitCredentialMetadataRunner } from "./gitCredentialMetadataProcess.js";
import { parseGitCredentialTarget, type GitCredentialTarget } from "./gitCredentialTarget.js";
import { inferGitProvider, type GitProviderEvidence } from "./gitProviderEvidence.js";

export async function readLinuxGitCredentialMetadata(
  runner: GitCredentialMetadataRunner,
  namespaces: string[],
  evidence: GitProviderEvidence[],
  signal: AbortSignal,
) {
  const prefix = ["--user", "--json=short", "--no-pager", "--auto-start=no"];
  const paths = new Set<string>();
  let partial = false,
    available = false;
  for (const schema of [
    "com.microsoft.GitCredentialManager",
    "org.git.Password",
    "org.gnome.keyring.NetworkPassword",
  ]) {
    const result = await runner({
      executable: "busctl",
      args: [
        ...prefix,
        "call",
        "org.freedesktop.secrets",
        "/org/freedesktop/secrets",
        "org.freedesktop.Secret.Service",
        "SearchItems",
        "a{ss}",
        "1",
        "xdg:schema",
        schema,
      ],
      signal,
    });
    if (result.status !== "ok") {
      partial = true;
      continue;
    }
    try {
      const data = JSON.parse(result.stdout);
      if (
        data.type !== "aoao" ||
        !Array.isArray(data.data) ||
        data.data.length !== 2 ||
        !data.data.every((a: unknown) => Array.isArray(a))
      )
        throw new Error("invalid");
      available = true;
      for (const path of data.data.flat())
        if (
          typeof path === "string" &&
          /^\/org\/freedesktop\/secrets\/collection\/[\w/]+$/.test(path)
        )
          paths.add(path);
    } catch {
      partial = true;
    }
  }
  const list = [...paths].slice(0, 200);
  if (paths.size > 200) partial = true;
  const accounts: GitCredentialTarget[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, list.length) }, async () => {
      while (index < list.length && !signal.aborted) {
        const path = list[index++]!;
        const result = await runner({
          executable: "busctl",
          args: [
            ...prefix,
            "get-property",
            "org.freedesktop.secrets",
            path,
            "org.freedesktop.Secret.Item",
            "Attributes",
          ],
          signal,
        });
        if (result.status !== "ok") {
          partial = true;
          continue;
        }
        try {
          const data = JSON.parse(result.stdout);
          // get-property 输出属性值子树，a{ss} 直接对应对象；方法返回才有外层参数数组。
          // 依据 systemd bus_message_dump 的 SUBTREE_ONLY 语义，不能按 SearchItems 解包。
          const attrs = data.data;
          if (
            data.type !== "a{ss}" ||
            !attrs ||
            typeof attrs !== "object" ||
            Array.isArray(attrs) ||
            !Object.values(attrs).every((v) => typeof v === "string")
          )
            throw new Error("invalid");
          let candidate: GitCredentialTarget | null = null;
          if (attrs.service)
            candidate = parseGitCredentialTarget(attrs.service, attrs.account ?? "", namespaces);
          else if (["http", "https"].includes(attrs.protocol) && attrs.server && attrs.user) {
            const url = new URL(attrs.protocol + "://" + attrs.server);
            if (attrs.port && Number(attrs.port) > 0) url.port = String(Number(attrs.port));
            url.pathname = attrs.object || "/";
            const known =
              attrs["xdg:schema"] === "org.git.Password" ||
              inferGitProvider(url.hostname) !== "server" ||
              url.hostname === "bitbucket.org" ||
              evidence.some((h) => new URL(h.serverUrl).origin === url.origin);
            if (known) candidate = parseGitCredentialTarget("git:" + url.href, attrs.user, ["git"]);
          }
          if (candidate) accounts.push(candidate);
        } catch {
          partial = true;
        }
      }
    }),
  );
  return { accounts, available, partial: partial || signal.aborted };
}
