import { parseGitCredentialTarget, type GitCredentialTarget } from "./gitCredentialTarget.js";
import { inferGitProvider, type GitProviderEvidence } from "./gitProviderEvidence.js";

function attribute(value: string) {
  if (value.startsWith("0x")) {
    const hex = value.match(/^0x([\da-f]+)/i)?.[1];
    return hex && hex.length % 2 === 0
      ? Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/, "")
      : "";
  }
  try {
    const text = JSON.parse(value);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}
export function parseMacGitCredentialMetadata(
  output: string,
  namespaces: string[],
  evidence: GitProviderEvidence[],
) {
  const accounts: GitCredentialTarget[] = [];
  const blocks = output.split(/(?=^keychain:)/m).filter((b) => /^keychain:/m.test(b));
  let partial = output.trim().length > 0 && !blocks.length;
  for (const block of blocks.slice(0, 5000)) {
    if (accounts.length >= 200) {
      partial = true;
      break;
    }
    const values: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\s*"(svce|acct|srvr|ptcl|port|path|desc)"<[^>]+>=(.+)$/);
      if (m) values[m[1]!] = m[2]!;
    }
    const account = attribute(values.acct ?? '""');
    const service = attribute(values.svce ?? '""');
    if (service) {
      const candidate = parseGitCredentialTarget(service, account, namespaces);
      if (candidate) accounts.push(candidate);
      continue;
    }
    if (!/^class:\s*"inet"/m.test(block)) continue;
    const server = attribute(values.srvr ?? '""'),
      proto = attribute(values.ptcl ?? '""');
    const protocol = proto === "htps" ? "https" : proto === "http" ? "http" : null;
    if (!server || !protocol || !account) continue;
    try {
      const url = new URL(protocol + "://" + server);
      const port = values.port?.match(/^0x([\da-f]+)/i)?.[1];
      if (port && parseInt(port, 16) > 0) url.port = String(parseInt(port, 16));
      url.pathname = attribute(values.path ?? '""') || "/";
      const known =
        inferGitProvider(url.hostname) !== "server" ||
        url.hostname === "bitbucket.org" ||
        evidence.some((h) => new URL(h.serverUrl).origin === url.origin) ||
        /\bgit\b/i.test(attribute(values.desc ?? '""'));
      if (known) {
        const candidate = parseGitCredentialTarget("git:" + url.href, account, ["git"]);
        if (candidate) accounts.push(candidate);
      }
    } catch {
      /* 无效属性不得变成可导入目标，也不返回原始钥匙串条目。 */
    }
  }
  return { accounts, partial: partial || blocks.length > 5000 };
}
