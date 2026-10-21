import type { GitAccountInput } from "@lcode/shared";
import type { GitCommandProvider } from "../git/providers/gitCommandProvider.js";

export async function detectSystemGitHubAccounts(
  command: GitCommandProvider,
  home: string,
  servers: string[],
) {
  const results = await Promise.all(
    [...new Set(["https://github.com", ...servers])].slice(0, 10).map(async (serverUrl) => {
      for (const helper of ["credential-manager", "credential-manager-core"]) {
        try {
          const result = await command.run({
            cwd: home,
            args: [
              helper,
              "github",
              "list",
              "--no-ui",
              ...(serverUrl === "https://github.com" ? [] : ["--url", serverUrl]),
            ],
            timeoutMs: 5000,
            maxOutputBytes: 65536,
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GCM_INTERACTIVE: "Never",
              GCM_TRACE: "0",
              GIT_TRACE: "0",
              GIT_TRACE2: "0",
              GIT_TRACE2_EVENT: "0",
              GIT_TRACE2_PERF: "0",
            },
          });
          if (result.timedOut || result.outputTruncated) return { accounts: [], failed: true };
          if (result.exitCode !== 0) continue;
          // GCM github list 的每一行是一个账号名；绝不调用 get/fill 或读取令牌内容。
          const users = result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(line));
          return {
            accounts: users.map(
              (username): GitAccountInput => ({
                name: `${username} · ${new URL(serverUrl).host}`,
                provider: "github",
                serverUrl,
                username,
                auth: "system",
                privateKeyPath: "",
              }),
            ),
            failed: false,
          };
        } catch {
          /* 缺少 Git/GCM 时保留其他静态来源，不向 UI 转交原始进程错误。 */
        }
      }
      return { accounts: [], failed: true };
    }),
  );
  return { accounts: results.flatMap((r) => r.accounts), failed: results.some((r) => r.failed) };
}
