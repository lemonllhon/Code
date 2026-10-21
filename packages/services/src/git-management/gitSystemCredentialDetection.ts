import type { GitSystemCredentialSource } from "@lcode/shared";
import type { GitCredentialMetadataRunner } from "./gitCredentialMetadataProcess.js";
import { parseGitCredentialTarget, type GitCredentialTarget } from "./gitCredentialTarget.js";
import type { GitProviderEvidence } from "./gitProviderEvidence.js";
import { readWindowsGitCredentialMetadata } from "./gitWindowsCredentialMetadata.js";
import { parseMacGitCredentialMetadata } from "./gitMacCredentialMetadata.js";
import { readLinuxGitCredentialMetadata } from "./gitLinuxCredentialMetadata.js";

export async function detectSystemGitCredentials(options: {
  platform: NodeJS.Platform;
  runner: GitCredentialMetadataRunner;
  namespaces?: string[];
  evidence?: GitProviderEvidence[];
}) {
  const namespaces = options.namespaces ?? ["git"],
    evidence = options.evidence ?? [];
  const source: GitSystemCredentialSource = {
    source:
      options.platform === "win32"
        ? "windows-credentials"
        : options.platform === "darwin"
          ? "macos-keychain"
          : "linux-secret-service",
    status: "ok",
    accountCount: 0,
  };
  const signal = AbortSignal.timeout(10000);
  let accounts: GitCredentialTarget[] = [];
  try {
    if (options.platform === "linux") {
      const result = await readLinuxGitCredentialMetadata(
        options.runner,
        namespaces,
        evidence,
        signal,
      );
      accounts = result.accounts;
      source.status = !result.available ? "unavailable" : result.partial ? "partial" : "ok";
    } else if (options.platform === "win32" || options.platform === "darwin") {
      const result =
        options.platform === "win32"
          ? await readWindowsGitCredentialMetadata(options.runner, namespaces, signal)
          : await options.runner({
              executable: "/usr/bin/security",
              args: ["dump-keychain"],
              signal,
            });
      if (result.status !== "ok") source.status = "unavailable";
      else if (options.platform === "darwin") {
        const parsed = parseMacGitCredentialMetadata(result.stdout, namespaces, evidence);
        accounts = parsed.accounts;
        source.status = parsed.partial ? "partial" : "ok";
      } else {
        const data = JSON.parse(result.stdout);
        if (!Array.isArray(data.items) || typeof data.partial !== "boolean")
          throw new Error("invalid");
        for (const record of data.items.slice(0, 200)) {
          if (typeof record?.target !== "string" || typeof record.userName !== "string")
            throw new Error("invalid");
          const account = parseGitCredentialTarget(record.target, record.userName, namespaces);
          if (account) accounts.push(account);
        }
        source.status = data.partial || data.items.length > 200 ? "partial" : "ok";
      }
    } else source.status = "unsupported";
  } catch {
    source.status = "partial";
  }
  accounts = accounts.filter(
    (a, index, all) =>
      all.findIndex((other) => other.serverUrl === a.serverUrl && other.username === a.username) ===
      index,
  );
  source.accountCount = accounts.length;
  return { accounts, source };
}
