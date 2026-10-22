import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  GitCredentialResult,
  GitCredentialRequest,
  GitAuthenticationReference,
} from "@lcode/shared";
import type { GitCommandProvider } from "../git/providers/gitCommandProvider.js";
import { readSystemGitCredential } from "./gitSystemCredential.js";

export const systemGitCredentialAttemptSchema = z
  .object({
    server: z.string().url(),
    username: z.string().max(512),
    confirmedUsername: z.string().max(512).optional(),
    id: z.string().uuid(),
  })
  .strict();
export type SystemGitCredentialAttempt = z.infer<typeof systemGitCredentialAttemptSchema>;
export type GitCredentialLifecycle = Pick<GitCredentialRequest, "operation" | "attemptId"> & {
  authentication?: Pick<GitAuthenticationReference, "id"> &
    Partial<Pick<GitAuthenticationReference, "revision">>;
};
type State = { systemCredentialAttempts: SystemGitCredentialAttempt[] };
const target = (value: string, username?: string) => {
  const url = new URL(value);
  return {
    server: url.origin,
    username: (username ?? decodeURIComponent(url.username)).toLowerCase(),
  };
};

/** 仅由明确账号保存/重选调用；原 profile 的 CAS 写入同时提交恢复意图。 */
export function resetSystemGitCredentialAttempts(state: State, value: string, username: string) {
  const key = target(value, username);
  for (let i = state.systemCredentialAttempts.length - 1; i >= 0; i--) {
    const attempt = state.systemCredentialAttempts[i]!;
    if (attempt.server === key.server && (!attempt.username || attempt.username === key.username))
      state.systemCredentialAttempts.splice(i, 1);
  }
}

export function createSystemGitCredentialGuard(options: {
  change<T>(edit: (state: State) => T): Promise<T>;
}) {
  return {
    async read(
      command: GitCommandProvider,
      cwd: string,
      value: string,
      username?: string,
    ): Promise<GitCredentialResult> {
      const requestedUsername =
        username ?? (decodeURIComponent(new URL(value).username) || undefined);
      const key = target(value, requestedUsername),
        id = randomUUID();
      // 中文依据：失败/取消没有可靠回报，必须先落盘占用再读取；不能靠超时或重启放行错误密码。
      await options.change((state) => {
        if (
          state.systemCredentialAttempts.some(
            (a) =>
              a.server === key.server &&
              (!a.username || !key.username || a.username === key.username),
          )
        )
          throw new Error("git-account-system-credential-blocked");
        state.systemCredentialAttempts.push({ ...key, id });
      });
      const credential = await readSystemGitCredential(command, cwd, value, requestedUsername);
      if (credential.kind !== "http") throw new Error("git-account-credential-unavailable");
      await options.change((state) => {
        const attempt = state.systemCredentialAttempts.find((a) => a.id === id);
        // 明确重选已经撤销的读取不能再把旧凭据交给 Git。
        if (!attempt) throw new Error("git-account-system-credential-blocked");
        attempt.confirmedUsername = credential.username.toLowerCase();
      });
      return { ...credential, attemptId: id };
    },
    async approve(value: string, username: string, id: string): Promise<GitCredentialResult> {
      if (!id || !["http:", "https:"].includes(new URL(value).protocol))
        throw new Error("git-account-invalid-approval");
      const key = target(value, username);
      await options.change((state) => {
        const index = state.systemCredentialAttempts.findIndex(
          (a) => a.id === id && a.server === key.server && a.confirmedUsername === key.username,
        );
        // 中文依据：旧 Git 迟到/重复的 store 只能释放原编号，不能放行之后失败的新尝试。
        if (index >= 0) state.systemCredentialAttempts.splice(index, 1);
      });
      return { kind: "ack" };
    },
  };
}
