import type { ExecutionPort, ExecutionRequest } from "@lcode/contracts";
import { createGitCredentialHelper, type GitCredentialResolver } from "@lcode/provider-node/git";
export type { GitCredentialResolver } from "@lcode/provider-node/git";

/** 仅适配原执行端口的子进程，不新增 writer、命令改写或重试。 */
export function createGitCredentialExecutionPort(
  base: ExecutionPort,
  resolve: GitCredentialResolver,
  processEnv: NodeJS.ProcessEnv = process.env,
): ExecutionPort {
  const helper = createGitCredentialHelper(resolve);
  let closing = false,
    closePromise: Promise<void> | undefined;
  const prepare = async (request: ExecutionRequest) => {
    if (closing) throw new Error("Git authentication execution port is closing");
    const source: NodeJS.ProcessEnv = request.env?.base === "empty" ? {} : { ...processEnv };
    for (const key of request.env?.unset ?? []) delete source[key];
    Object.assign(source, request.env?.set);
    const enforced = await helper.environment(source);
    const additions = Object.fromEntries(
      Object.entries(enforced).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    if (closing) throw new Error("Git authentication execution port is closing");
    return {
      ...request,
      env: {
        ...request.env,
        set: { ...request.env?.set, ...additions },
        unset: [
          ...(request.env?.unset?.filter((k) => !(k in additions)) ?? []),
          ...Object.keys(enforced).filter((k) => enforced[k] === undefined),
        ],
      },
    };
  };
  const port: ExecutionPort = {
    async run(request, options) {
      options?.signal?.throwIfAborted();
      const next = await prepare(request);
      options?.signal?.throwIfAborted();
      return base.run(next, options);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      return (closePromise = (async () => {
        try {
          await base.close?.();
        } finally {
          // 原执行器关闭异常也必须撤销认证通道，同时保留原异常供恢复边界处理。
          await helper.close();
        }
      })());
    },
  };
  if (base.start)
    port.start = async (request, options) => {
      options?.signal?.throwIfAborted();
      const next = await prepare(request);
      options?.signal?.throwIfAborted();
      return base.start!(next, options);
    };
  if (base.runBashWithBackgroundLifecycle)
    port.runBashWithBackgroundLifecycle = async (request, lifecycle, options) => {
      options?.signal?.throwIfAborted();
      const next = await prepare(request);
      options?.signal?.throwIfAborted();
      return base.runBashWithBackgroundLifecycle!(next, lifecycle, options);
    };
  if (base.getBackgroundTask) port.getBackgroundTask = (id) => base.getBackgroundTask!(id);
  if (base.waitForBackgroundTask)
    port.waitForBackgroundTask = (id, options) => base.waitForBackgroundTask!(id, options);
  if (base.readBackgroundBashOutput)
    port.readBackgroundBashOutput = (id, session) => base.readBackgroundBashOutput!(id, session);
  if (base.cancelBackgroundTask) port.cancelBackgroundTask = (id) => base.cancelBackgroundTask!(id);
  return port;
}
