import { z } from "zod";
import {
  BashInputSchema,
  BashOutputSchema,
  type JsonSchema,
  type TraceContext,
} from "@lcode/contracts";
import { gitAccountOperationSchema, gitAccountOperationResultSchema } from "@lcode/shared";
import type { AgentRuntimeDeps } from "../../runtime/types.js";
import type { ToolEntry } from "../types.js";
import { resolveToolWorkingDirectory } from "../path-policy.js";
import { bashToolEntry } from "./bash.js";
import { toBashOutput } from "./bash-output.js";

const text = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine((s) => !/[\r\n\0]/.test(s));
export const gitToolInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("inspect"), cwd: text.optional(), url: text }),
  z.strictObject({
    action: z.literal("bind"),
    cwd: text.optional(),
    url: text,
    username: text,
    auth: z.enum(["system", "token", "oauth", "ssh"]).optional(),
    expectedRevision: text,
  }),
  z.strictObject({
    action: z.enum(["fetch", "push", "ls-remote"]),
    cwd: text.optional(),
    remote: text.regex(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/).default("origin"),
    refs: z
      .array(text.refine((s) => !s.startsWith("-")))
      .max(40)
      .default([]),
    flags: z
      .array(
        z.enum(["--prune", "--tags", "--no-tags", "--follow-tags", "--set-upstream", "--dry-run"]),
      )
      .max(6)
      .default([]),
    timeout: z.number().int().min(1).max(600000).default(60000),
  }),
]);

export function createGitToolEntry(
  resolveAccount?: AgentRuntimeDeps["resolveGitAccount"],
): ToolEntry {
  return {
    ...bashToolEntry,
    capability:
      "Inspect and bind remembered Git account preferences; execute one Git network operation with its actual result",
    metadata: {
      ...bashToolEntry.metadata,
      name: "Git",
      description: [
        "Use this tool for Git fetch, push and ls-remote. Each call executes one argv command and preserves full errors and its exit code; never verify a failed fetch by retrying a push.",
        "Before network operations, compare user-approved account preferences from project memory with live Git context. Use inspect for current URL candidates/revision, then bind the specified username/auth with that revision when necessary. A remembered preference is intent, not credentials or write approval. Do not guess from repository owner/author, switch helpers, or silently replace a stale account.",
        "Fetch/Push for the same target share the Host binding. Distinct repositories and multi-remote targets remain separate. No shell pipelines, truncation, forced push or automatic retry.",
      ].join("\n"),
    },
    inputSchema: z.toJSONSchema(gitToolInputSchema) as JsonSchema,
    runtimeInputSchema: gitToolInputSchema,
    formatModelContent: (output) => {
      const content = bashToolEntry.formatModelContent!(output);
      const parsed = BashOutputSchema.safeParse(output);
      if (!parsed.success || typeof content !== "string") return content;
      const result = parsed.data;
      return [
        content,
        `Git exit code: ${result.exitCode ?? "unavailable"}`,
        result.stdoutTruncated && result.stdoutPersistedOutputPath
          ? `Full stdout: ${result.stdoutPersistedOutputPath}`
          : "",
        result.stderrTruncated && result.stderrPersistedOutputPath
          ? `Full stderr: ${result.stderrPersistedOutputPath}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    permission: {
      ...bashToolEntry.permission,
      permission: "git",
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
    },
    resolvePermissionRulePolicy: undefined,
    resolveTimeoutBudgetMs: undefined,
    resolvePermissionCapability: (input) =>
      (input as { action?: string })?.action === "inspect"
        ? {
            readOnly: true,
            needsApproval: false,
            sideEffectScope: "none",
            riskLevel: "low",
            permission: { needsApproval: false, sideEffectScope: "none", riskLevel: "low" },
          }
        : undefined,
    handler: async (input, context) => {
      const parsed = gitToolInputSchema.parse(input);
      const cwd = resolveToolWorkingDirectory(parsed.cwd, {
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
        operation: "execute",
      });
      context.abortSignal.throwIfAborted();
      if (parsed.action === "inspect" || parsed.action === "bind") {
        const resolveTargetAccount = context.resolveProjectGitAccount ?? resolveAccount;
        if (!resolveTargetAccount) throw new Error("git-account-scope-unavailable");
        const result = gitAccountOperationResultSchema.parse(
          await resolveTargetAccount(
            gitAccountOperationSchema.parse({ ...parsed, cwd }),
            context.abortSignal,
          ),
        );
        if (result.status === "error")
          return { result: false, errorCode: 1, message: result.error };
        return {
          stdout: JSON.stringify(result),
          stderr: "",
          status: "completed",
          exitCode: 0,
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        };
      }
      if (!context.executionPort) throw new Error("Git execution port is unavailable");
      // 中文依据：每个 Git 网络动作独立执行，避免管道 tail 和后续命令覆盖真实失败/退出码。
      const result = await context.executionPort.run(
        {
          command: {
            mode: "argv",
            file: "git",
            args: [parsed.action, ...parsed.flags, "--", parsed.remote, ...parsed.refs],
          },
          cwd,
          timeoutMs: parsed.timeout,
          outputLimit: { persistOutput: "always", maxInlineBytes: 30000, maxBufferBytes: 30000 },
          trace: {
            traceId: context.traceId,
            spanId: context.spanId,
            sessionId: context.sessionId,
            turnId: context.turnId,
            attributes: { toolName: "Git", toolCallId: context.toolCallId },
          } as TraceContext,
        },
        { signal: context.abortSignal },
      );
      return toBashOutput(
        result,
        BashInputSchema.parse({
          command: `git ${parsed.action}`,
          description: "Git network operation",
        }),
        context,
      );
    },
  };
}
