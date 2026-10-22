import type { GitCredentialResult } from "@lcode/shared";
import type { GitCommandProvider } from "../git/providers/gitCommandProvider.js";

/** 指定用户名的系统凭据读取；保持非交互和原有秘密隔离边界。 */
export async function readSystemGitCredential(
  command: GitCommandProvider,
  cwd: string,
  value: string,
  username?: string,
): Promise<GitCredentialResult> {
  const result = await command.run({
    cwd: cwd,
    args: [
      "-c",
      "credential.trace=false",
      "-c",
      "credential.traceSecrets=false",
      "credential",
      "fill",
    ],
    maxOutputBytes: 65536,
    timeoutMs: 60000,
    stdin: `url=${value}\n${username ? `username=${username}\n` : ""}\n`,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_TRACE: "0",
      GIT_TRACE_CURL: "0",
      GIT_CURL_VERBOSE: undefined,
      GCM_TRACE: "0",
      GCM_TRACE_SECRETS: "0",
      GIT_TRACE_REDACT: "1",
      GIT_ASKPASS: "",
      LCODE_GIT_HELPER_ENDPOINT: undefined,
      LCODE_GIT_HELPER_CAPABILITY: undefined,
      ...(process.env.LCODE_GIT_HELPER_ENDPOINT ? { GIT_CONFIG_COUNT: "0" } : {}),
      GIT_TRACE2: "0",
      GIT_TRACE2_EVENT: "0",
      GIT_TRACE2_PERF: "0",
    },
  });
  const lines = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => {
        const at = l.indexOf("=");
        return [l.slice(0, at), l.slice(at + 1)];
      }),
  );
  if (
    result.exitCode !== 0 ||
    !lines.password ||
    !lines.username ||
    (username && lines.username !== username)
  )
    throw new Error("git-account-credential-unavailable");
  return { kind: "http", username: lines.username, password: lines.password };
}
