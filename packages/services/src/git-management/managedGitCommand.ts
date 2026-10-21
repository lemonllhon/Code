import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  GitCommandProvider,
  GitCommandExecutionOptions,
} from "../git/providers/gitCommandProvider.js";
import { createGitCommandProvider } from "../git/providers/gitCommandProvider.js";
import { createGitEnvironmentProvider } from "../git/providers/gitEnvironmentProvider.js";
import type { GitManagementOwner } from "./gitManagementService.js";

function commandIndex(args: string[]) {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    if (args[index] === "-c" || args[index] === "-C") index += 2;
    else index++;
  }
  return index;
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
async function assertSSHKey(account: { auth: string; privateKeyPath: string } | null) {
  if (account?.auth !== "ssh" || !account.privateKeyPath) return;
  const key = account.privateKeyPath;
  if (!isAbsolute(key) || !(await lstat(key).catch(() => null))?.isFile())
    throw new Error("ssh-key-unavailable");
}
export function createManagedGitCommand(
  owner: GitManagementOwner,
  provided?: GitCommandProvider,
): GitCommandProvider {
  const raw =
    provided ??
    createGitCommandProvider({
      environmentProvider: createGitEnvironmentProvider({
        configuredBinary: async () => (await owner.configuration()).binaryPath,
      }),
    });
  return {
    resolveGitBinary: () => raw.resolveGitBinary(),
    async validateAuthentication(url, reference) {
      await assertSSHKey((await owner.authentication(url, reference)).account);
    },
    async run(input: GitCommandExecutionOptions) {
      const config = await owner.configuration(),
        pairs: [string, string][] = [];
      if (config.userName) pairs.push(["user.name", config.userName]);
      if (config.userEmail) pairs.push(["user.email", config.userEmail]);
      const index = commandIndex(input.args),
        verb = input.args[index];
      let url: string | undefined,
        reference: Parameters<typeof owner.authentication>[1] = input.authentication;
      if (verb === "clone") {
        const separator = input.args.indexOf("--", index + 1);
        url = separator >= 0 ? input.args[separator + 1] : undefined;
      } else if (verb === "fetch" || verb === "push") {
        const binding = await raw.run({
          cwd: input.cwd,
          args: ["config", "--local", "--get", "lcode.accountId"],
        });
        if (binding.exitCode !== 0 && binding.exitCode !== 1)
          throw new Error("git-account-binding-unavailable");
        if (binding.stdout.trim()) reference = { id: binding.stdout.trim() };
        if (reference) {
          const separator = input.args.indexOf("--", index + 1),
            remote = separator >= 0 ? input.args[separator + 1] : undefined;
          if (!remote) throw new Error("git-account-remote-unavailable");
          const remoteResult = await raw.run({
            cwd: input.cwd,
            args: [
              "remote",
              "get-url",
              ...(verb === "push" ? ["--push"] : []),
              "--all",
              "--",
              remote,
            ],
          });
          const urls = remoteResult.stdout.trim().split(/\r?\n/).filter(Boolean);
          if (remoteResult.exitCode !== 0 || !urls.length)
            throw new Error("git-account-remote-unavailable");
          for (const candidate of urls) await owner.authentication(candidate, reference);
          url = urls[0];
        }
      }
      const auth =
        url && reference ? await owner.authentication(url, reference) : { account: null };
      let env: NodeJS.ProcessEnv = { ...input.env };
      const secret = auth.secret,
        encoded =
          secret && auth.account
            ? Buffer.from(
                `${auth.account.auth === "oauth" && auth.account.provider === "gitlab" ? "oauth2" : auth.account.username}:${secret}`,
              ).toString("base64")
            : undefined;
      if (auth.account?.auth === "token" || auth.account?.auth === "oauth") {
        const server = new URL(auth.account.serverUrl);
        server.pathname = server.pathname.replace(/\/?$/, "/");
        const scope = `http.${server.href}`;
        pairs.push(
          [`${scope}.extraHeader`, ""],
          [`${scope}.extraHeader`, `Authorization: Basic ${encoded}`],
          ["credential.helper", ""],
          ["http.followRedirects", "false"],
          [`${scope}.followRedirects`, "false"],
        );
        // Git trace 与 curl verbose 会打印认证头；认证命令必须先清除继承的诊断开关。
        env = {
          ...env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          GIT_TRACE: "0",
          GIT_TRACE_CURL: "0",
          GIT_TRACE_CURL_NO_DATA: undefined,
          GIT_CURL_VERBOSE: undefined,
          GIT_TRACE_PACKET: "0",
          GIT_TRACE2: "0",
          GIT_TRACE2_EVENT: "0",
          GIT_TRACE2_PERF: "0",
          GIT_TRACE_REDACT: "1",
        };
      } else if (auth.account?.auth === "ssh") {
        const key = auth.account.privateKeyPath;
        await assertSSHKey(auth.account);
        env.GIT_SSH_COMMAND = `ssh -o BatchMode=yes${key ? ` -o IdentitiesOnly=yes -i ${quote(key.replace(/\\/g, "/"))}` : ""}`;
        env.GIT_TERMINAL_PROMPT = "0";
      } else if (auth.account?.auth === "system") {
        // 同一服务器存在多个系统账号时必须限定用户名，不能跟随 helper 当前活动账号串用身份。
        const server = new URL(auth.account.serverUrl);
        server.pathname = server.pathname.replace(/\/?$/, "/");
        pairs.push([`credential.${server.href}.username`, auth.account.username]);
        env.GIT_TERMINAL_PROMPT = "0";
        env.GCM_INTERACTIVE = "Never";
      }
      if (pairs.length) {
        // 每次调用独立构造配置环境，不能在并发仓库之间共享或持久化认证头。
        const prior = Number(env.GIT_CONFIG_COUNT ?? 0);
        if (!Number.isSafeInteger(prior) || prior < 0 || prior > 100)
          throw new Error("invalid-git-config-environment");
        pairs.forEach(([key, value], offset) => {
          env[`GIT_CONFIG_KEY_${prior + offset}`] = key;
          env[`GIT_CONFIG_VALUE_${prior + offset}`] = value;
        });
        env.GIT_CONFIG_COUNT = String(prior + pairs.length);
      }
      const args =
        verb === "clone" && auth.account
          ? [
              ...input.args.slice(0, index + 1),
              "--config",
              `lcode.accountId=${auth.account.id}`,
              ...input.args.slice(index + 1),
            ]
          : input.args;
      const result = await raw.run({ ...input, args, env });
      const redact = (value: string) =>
        [secret, encoded]
          .filter((v): v is string => Boolean(v))
          .reduce((text, value) => text.split(value).join("[redacted]"), value);
      return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    },
  };
}
