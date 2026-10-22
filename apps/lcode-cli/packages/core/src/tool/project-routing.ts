import { posix, win32 } from "node:path";
import {
  gitAccountOperationResultSchema,
  decodeProjectNativeValue,
  encodeProjectNativeValue,
  replaceRemoteWorkspaceIdentityPath,
  type ProjectContextSnapshot,
  type ProjectNativeOperation,
} from "@lcode/shared";
import type { ExecutionPort, FileSystemPort } from "@lcode/contracts";
import type { AgentRuntimeDeps } from "../runtime/types.js";
import type { ToolExecutorDeps } from "./executor/types.js";

export const PROJECT_NATIVE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "Git",
]);
export const projectPathApi = (path: string) =>
  /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? win32 : posix;
const environmentKey = (member: { workspaceIdentity?: string }) =>
  member.workspaceIdentity
    ? replaceRemoteWorkspaceIdentityPath(member.workspaceIdentity, "/")
    : "local";

export function selectProjectToolMember(
  snapshot: ProjectContextSnapshot,
  input: Record<string, unknown>,
) {
  const explicit = input.projectMemberId;
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "string") throw new Error("projectMemberId must be a member ID");
    const member = snapshot.members.find((candidate) => candidate.memberId === explicit);
    if (!member) throw new Error("Target folder is outside the accepted project scope");
    return member;
  }
  const path = [input.file_path, input.path, input.cwd].find(
    (value) => typeof value === "string",
  ) as string | undefined;
  if (path && projectPathApi(path).isAbsolute(path)) {
    const matches = snapshot.members.filter((member) => {
      const api = projectPathApi(member.workspacePath);
      if (api !== projectPathApi(path)) return false;
      const child = api.relative(member.workspacePath, path);
      return !api.isAbsolute(child) && child !== ".." && !child.startsWith(`..${api.sep}`);
    });
    if (new Set(matches.map(environmentKey)).size > 1)
      throw new Error("Ambiguous target path on multiple devices; specify projectMemberId");
    if (matches.length)
      return matches.sort((a, b) => b.workspacePath.length - a.workspacePath.length)[0]!;
  }
  const primary = snapshot.members.find(
    (member) =>
      member.workspacePath === snapshot.execution.workspacePath &&
      (member.workspaceIdentity ?? "") === (snapshot.execution.workspaceIdentity ?? ""),
  );
  if (!primary) throw new Error("Accepted primary folder is unavailable");
  return primary;
}

/** 每个端口对象仅绑定不可变 capability；并发工具和后台任务不能读取后来切换的主要目录。 */
export function createProjectToolRouting(options: {
  ownerId: string;
  call: NonNullable<AgentRuntimeDeps["projectNativeCall"]>;
  snapshot(): ProjectContextSnapshot | undefined;
  baseExecution?: ExecutionPort;
}) {
  let activeSnapshot: ProjectContextSnapshot | undefined;
  const targets = new Map<
    string,
    {
      filesystem: FileSystemPort;
      execution: ExecutionPort;
      reads: ToolExecutorDeps["readFileState"];
      cwd: string;
    }
  >();
  const tasks = new Map<string, ExecutionPort>();
  const target = (member: ProjectContextSnapshot["members"][number]) => {
    const routeToken = member.routeToken;
    if (!routeToken)
      throw new Error(
        "Target device routing capability is unavailable; reconnect and retry this input",
      );
    let existing = targets.get(routeToken);
    if (existing) return existing;
    const invoke = async (
      port: ProjectNativeOperation["port"],
      method: ProjectNativeOperation["method"],
      args: unknown[],
      signal?: AbortSignal,
    ) => {
      signal?.throwIfAborted();
      const request = {
        routeToken,
        ownerId: options.ownerId,
        callId: crypto.randomUUID(),
        operation: { port, method, args: args.map(encodeProjectNativeValue) },
      };
      const abort = () => {
        void options
          .call({ ...request, operation: { port: "execution", method: "cancelCall", args: [] } })
          .catch(() => undefined);
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const value = decodeProjectNativeValue(await options.call(request));
        if (value && typeof value === "object" && "$nativeFailure" in value)
          throw Object.assign(new Error(String((value as { message?: unknown }).message)), value);
        return value;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    };
    const filesystem = new Proxy({} as FileSystemPort, {
      get: (_object, name: string) => (request: unknown, opts?: { signal?: AbortSignal }) =>
        invoke("filesystem", name as ProjectNativeOperation["method"], [request], opts?.signal),
    });
    const execution = new Proxy({} as ExecutionPort, {
      get:
        (_object, name: string) =>
        async (...args: unknown[]) => {
          const optionIndex = name === "runBashWithBackgroundLifecycle" ? 2 : 1;
          const signal = (args[optionIndex] as { signal?: AbortSignal } | undefined)?.signal;
          if (["run", "start", "runBashWithBackgroundLifecycle"].includes(name)) {
            const request = { ...(args[0] as Record<string, unknown>) };
            // 源设备 Shell 路径和 prelude 不能传播到另一平台；目标 Agent 自行选择和校验 Shell。
            if (request.command && typeof request.command === "object") {
              const command = { ...request.command } as Record<string, unknown>;
              delete command.shellOverride;
              request.command = command;
            }
            delete request.bashPrelude;
            args[0] = request;
          }
          if (args.length > optionIndex && name !== "readBackgroundBashOutput")
            args.splice(optionIndex);
          const result = await invoke(
            "execution",
            name as ProjectNativeOperation["method"],
            args,
            signal,
          );
          if (result && typeof result === "object") {
            const record = result as Record<string, unknown>;
            const id =
              record.taskId ??
              (record.task && typeof record.task === "object"
                ? (record.task as Record<string, unknown>).taskId
                : undefined);
            if (typeof id === "string") tasks.set(id, execution);
          }
          return result;
        },
    });
    existing = { filesystem, execution, reads: new Map(), cwd: member.workspacePath };
    targets.set(routeToken, existing);
    return existing;
  };
  const backgroundExecution = new Proxy(options.baseExecution ?? ({} as ExecutionPort), {
    get: (base, name: keyof ExecutionPort) => {
      if (
        [
          "getBackgroundTask",
          "waitForBackgroundTask",
          "readBackgroundBashOutput",
          "cancelBackgroundTask",
        ].includes(name)
      )
        return (taskId: string, ...args: unknown[]) => {
          const owner = tasks.get(taskId) ?? base;
          const method = owner[name] as ((...args: unknown[]) => unknown) | undefined;
          if (!method) throw new Error("Background task owner unavailable");
          return method.call(owner, taskId, ...args);
        };
      const value = base[name];
      return typeof value === "function" ? value.bind(base) : value;
    },
  });
  return {
    backgroundExecution,
    resolve(
      toolName: string,
      input: Record<string, unknown>,
    ): Partial<ToolExecutorDeps> | undefined {
      const snapshot = options.snapshot();
      if (!snapshot || !PROJECT_NATIVE_TOOLS.has(toolName)) return undefined;
      if (activeSnapshot !== snapshot) {
        activeSnapshot = snapshot;
        // 每轮 admission 的默认目录重新来自主要成员；上一轮的 cd 不能替代新轮固定的执行位置。
        for (const member of snapshot.members) {
          const previous = member.routeToken ? targets.get(member.routeToken) : undefined;
          if (previous) previous.cwd = member.workspacePath;
        }
      }
      const member = selectProjectToolMember(snapshot, input);
      if (!member.routeToken) {
        if (
          new Set([environmentKey(snapshot.origin), ...snapshot.members.map(environmentKey)]).size >
          1
        )
          throw new Error("Mixed device routing capability unavailable");
        const primary = member.workspacePath === snapshot.execution.workspacePath;
        return primary
          ? {}
          : {
              getWorkingDirectory: () => member.workspacePath,
              getWorkspaceRoot: () => member.workspacePath,
              setWorkingDirectory: undefined,
            };
      }
      const ports = target(member);
      const selectedCwd = ports.cwd;
      return {
        fileSystemPort: ports.filesystem,
        executionPort: ports.execution,
        readFileState: ports.reads,
        workspaceIdentity: member.workspaceIdentity,
        remoteSessionId: undefined,
        embeddedSearchBackend: undefined,
        nativeSearchEnhancementsEnabled: false,
        getWorkingDirectory: () => selectedCwd,
        getWorkspaceRoot: () => member.workspacePath,
        setWorkingDirectory: (cwd) => {
          if (activeSnapshot === snapshot) ports.cwd = cwd;
        },
        getBashShellSelection: () => undefined,
        bashShellSelection: undefined,
        resolveProjectGitAccount: async (operation) =>
          gitAccountOperationResultSchema.parse(
            decodeProjectNativeValue(
              await options.call({
                routeToken: member.routeToken!,
                ownerId: options.ownerId,
                callId: crypto.randomUUID(),
                operation: {
                  port: "gitAccount",
                  method: "resolve",
                  args: [encodeProjectNativeValue(operation)],
                },
              }),
            ),
          ),
      };
    },
  };
}
