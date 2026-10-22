import { z } from "zod";
import { createGitCredentialExecutionPort } from "../app/git-credential-execution.js";
import {
  lcodeWorkspaceRefSchema,
  type LCodeWorkspaceRef,
  type GitCredentialRequest,
  type GitCredentialResult,
} from "@lcode/shared";
import { createNodeExecutionAdapter } from "@lcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@lcode/adapters/fs";
import {
  projectNativeRequestSchema,
  encodeProjectNativeValue,
  decodeProjectNativeValue,
} from "@lcode/shared";
import type { ExecutionPort, FileSystemPort } from "@lcode/contracts";

const fsMethods = new Set([
  "createDirectory",
  "stat",
  "readTextFile",
  "readBinaryFile",
  "readTextFileRange",
  "writeTextFile",
  "removeFile",
  "listDirectory",
  "searchFiles",
  "searchText",
]);
const execMethods = new Set([
  "run",
  "runBashWithBackgroundLifecycle",
  "start",
  "getBackgroundTask",
  "waitForBackgroundTask",
  "readBackgroundBashOutput",
  "cancelBackgroundTask",
]);

/** 目标 Agent 的资源端口；不创建会话、模型、输入队列或第二个 runtime。 */
export class ProjectNativeServer {
  private closed = false;
  private readonly owners = new Map<
    string,
    {
      fs: FileSystemPort;
      exec: ExecutionPort;
      calls: Map<string, AbortController>;
      closing?: boolean;
    }
  >();
  constructor(
    private readonly resolveGitCredential?: (
      workspace: LCodeWorkspaceRef,
      ownerId: string,
      request: Omit<GitCredentialRequest, "workspace" | "sessionId">,
    ) => Promise<GitCredentialResult>,
  ) {}
  async call(input: unknown) {
    const envelope = z
      .strictObject({ request: projectNativeRequestSchema, workspace: lcodeWorkspaceRefSchema })
      .parse(input);
    const { request, workspace } = envelope;
    const { operation, ownerId, callId } = request;
    // 关闭后迟到的已准入 RPC 也不能重新创建资源；清理与取消保持幂等。
    if (this.closed) {
      if (["close", "cancelCall"].includes(operation.method)) return null;
      throw new Error("Project native resources are closing");
    }
    let owner = this.owners.get(ownerId);
    if (operation.method === "cancelCall") {
      owner?.calls.get(callId)?.abort();
      return null;
    }
    if (operation.method === "close") {
      if (owner) {
        owner.closing = true;
        for (const controller of owner.calls.values()) controller.abort();
        await owner.exec.close?.();
        if (this.owners.get(ownerId) === owner) this.owners.delete(ownerId);
      }
      return null;
    }
    if (owner?.closing) throw new Error("Project native resource owner is closing");
    if (!owner) {
      owner = {
        fs: createNodeFileSystemAdapter(),
        exec: this.resolveGitCredential
          ? createGitCredentialExecutionPort(createNodeExecutionAdapter(), (credential) =>
              this.resolveGitCredential!(workspace, ownerId, credential),
            )
          : createNodeExecutionAdapter(),
        calls: new Map(),
      };
      this.owners.set(ownerId, owner);
    }
    const allowed = operation.port === "filesystem" ? fsMethods : execMethods;
    if (!allowed.has(operation.method)) throw new Error("Unsupported project native operation");
    const args = operation.args.map(decodeProjectNativeValue);
    const payload = args[0];
    if (
      operation.port === "filesystem" &&
      (!payload ||
        typeof payload !== "object" ||
        !("path" in payload) ||
        typeof payload.path !== "string")
    )
      throw new Error("Invalid native filesystem request");
    if (
      operation.port === "execution" &&
      ["run", "start", "runBashWithBackgroundLifecycle"].includes(operation.method) &&
      (!payload || typeof payload !== "object" || !("command" in payload))
    )
      throw new Error("Invalid native execution request");
    const controller = new AbortController();
    if (owner.calls.has(callId)) throw new Error("Duplicate native call id");
    owner.calls.set(callId, controller);
    try {
      const port = operation.port === "filesystem" ? owner.fs : owner.exec;
      const method = (port as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[
        operation.method
      ];
      if (!method) throw new Error("Native operation unavailable on target Agent");
      // signal 属于目标执行资源；不能把源设备的 AbortSignal 作为 JSON 对象传给适配器。
      if (operation.method === "runBashWithBackgroundLifecycle")
        args[2] = { signal: controller.signal };
      else if (
        ["run", "start", "waitForBackgroundTask"].includes(operation.method) ||
        operation.port === "filesystem"
      )
        args[1] = { signal: controller.signal };
      return encodeProjectNativeValue(await method.apply(port, args));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return encodeProjectNativeValue({
        $nativeFailure: true,
        name: failure.name,
        message: failure.message,
        ...Object.fromEntries(Object.entries(failure)),
      });
    } finally {
      owner.calls.delete(callId);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const owners = [...this.owners.entries()];
    const outcomes = await Promise.allSettled(
      owners.map(async ([id, owner]) => {
        owner.closing = true;
        for (const controller of owner.calls.values()) controller.abort();
        await owner.exec.close?.();
        if (this.owners.get(id) === owner) this.owners.delete(id);
      }),
    );
    // 失败的资源仍由原 owner 持有，shutdown 重试不能因为提前清空 Map 而漏掉它。
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Project native resource cleanup failed",
      );
  }
}
