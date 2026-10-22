import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "@lcode/core";
import { createNodeFileSystemAdapter, createSqliteSessionStore } from "@lcode/adapters";
import { createInMemorySessionEventStore, type Model, type SessionId } from "@lcode/contracts";
import type { GitAgentRepositoryContext } from "@lcode/shared";

test("Runtime recalls an approved account preference, inspects/binds through Host and reports independent fetch failure without push replay", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "git-account-memory-"));
  await mkdir(join(root, ".lcode", "memory"), { recursive: true });
  await writeFile(
    join(root, ".lcode", "memory", "git-workflow.md"),
    "# Git 约定\n\n用户已确认 fixture 仓库使用 preferred-bob；Fetch 和 Push 复用明确账号，不能依赖系统默认账号。\n",
  );
  const store = createSqliteSessionStore({ dbPath: join(root, "session.db") });
  const fs = createNodeFileSystemAdapter();
  const url = "https://example.invalid/fixture.git";
  const repository: GitAgentRepositoryContext = {
    workspacePath: root,
    revision: "revision-1",
    status: "available",
    partial: false,
    remotes: [{ name: "origin", url, authentication: { status: "selection-required" } }],
  };
  const operations: string[] = [],
    executions: string[] = [];
  let steps = 0;
  const model = {
    providerId: "fixture",
    modelId: "git-account",
    displayName: "Fixture",
    options: { maxOutputTokens: 8192 },
    optionSpecs: { maxOutputTokens: { max: 8192 } },
    properties: {
      contextWindow: 1000000,
      inputFormat: { supportsText: true },
      supportsMidConversationSystem: true,
    },
    bind: () => model,
    generateText: async (request: any) => {
      steps++;
      assert.ok(steps <= 4, "No automatic network retries");
      assert.ok(request.tools.some((tool: any) => tool.name === "Git"));
      const messages = JSON.stringify(request.messages);
      assert.match(messages, /preferred-bob/);
      let input: unknown;
      if (steps === 1) input = { action: "inspect", url };
      if (steps === 2) {
        assert.match(messages, /revision-1/);
        input = {
          action: "bind",
          url,
          username: "preferred-bob",
          auth: "system",
          expectedRevision: "revision-1",
        };
      }
      if (steps === 3) {
        assert.equal(repository.remotes[0]!.authentication.status, "selected");
        input = { action: "fetch" };
      }
      if (input)
        return {
          text: "",
          finishReason: "tool-calls",
          usage: {},
          toolCalls: [{ id: `git-${steps}`, name: "Git", input }],
        };
      assert.match(messages, /Exit code 128/);
      assert.match(messages, /git-account-binding-stale/);
      return { text: "Fetch 认证失败，未重新推送。", finishReason: "stop", usage: {} };
    },
  } as unknown as Model;
  const runtime = new AgentRuntime(
    "sess_git_preference" as SessionId,
    {
      workingDirectory: root,
      workspacePath: root,
      mode: "yolo",
      modelSelection: { providerId: "fixture", modelId: "git-account" },
      modelStreaming: "off",
      memory: {
        enabled: true,
        use: true,
        storageLocation: "workspace",
        cliStorageRoot: join(root, "cli"),
      },
      compact: { enabled: false },
      subagents: { enabled: false },
      mcp: { enabled: false },
      titleGeneration: { enabled: false },
      toolAllowlist: ["Git"],
    },
    {
      sessionStore: store,
      fileSystemPort: fs,
      modelFactory: () => model,
      eventStore: createInMemorySessionEventStore(),
      resolveGitContext: async () => ({
        status: "available",
        partial: false,
        repositories: [repository],
      }),
      resolveGitAccount: async (operation) => {
        operations.push(operation.action);
        if (operation.action === "bind") {
          assert.equal(operation.username, "preferred-bob");
          assert.equal(operation.expectedRevision, "revision-1");
          repository.remotes[0]!.authentication = {
            status: "selected",
            account: { name: "Fixture", username: "preferred-bob", provider: "github" },
          };
        }
        return {
          status: "ok",
          revision: "revision-1",
          choices: [{ username: "preferred-bob", auth: "system", provider: "github" }],
          repository,
        };
      },
      executionPort: {
        run: async (request) => {
          assert.equal(request.command.mode, "argv");
          if (request.command.mode === "argv") executions.push(request.command.args![0]!);
          const text =
            "git-account-binding-stale\nSelect or reload the repository account in Git > Remotes\nfatal: could not read Username";
          return {
            status: "failed",
            exitCode: 128,
            stdout: { text: "", bytes: 0, truncated: false },
            stderr: { text, bytes: text.length, truncated: false },
            timedOut: false,
            cancelled: false,
            durationMs: 1,
            startedAt: new Date(),
            completedAt: new Date(),
          };
        },
      },
    },
  );
  try {
    await runtime.executeTurn("按已确认的账号约定关联仓库，然后 Fetch。", undefined, {
      abortSignal: t.signal,
    });
    assert.deepEqual(operations, ["inspect", "bind"]);
    assert.deepEqual(executions, ["fetch"]);
    assert.equal(steps, 4);
  } finally {
    runtime.beginShutdown();
    await store.close();
  }
});
