import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileSystemAdapter, createSqliteSessionStore } from "@lcode/adapters";
import { AgentRuntime } from "@lcode/core";
import {
  createInMemorySessionEventStore,
  type Model,
  type ModelRequest,
  type SessionId,
  type SessionEvent,
} from "@lcode/contracts";
import type { GitAgentContext } from "@lcode/shared";

test("Runtime combines live Git accounts and learned conventions without persisting transient facts or duplicating learning", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "git-memory-runtime-"));
  const memoryRoot = join(root, ".lcode", "memory"),
    fileName = "git-workflow.md";
  await mkdir(memoryRoot, { recursive: true });
  const before = "# Git 提交与审核约定\n\n提交使用 Conventional Commits；提交前检查文件范围。\n";
  const after = `${before}\n审核时排除生成的构建产物；发布前检查远端与 Tag 目标。\n`;
  await writeFile(join(memoryRoot, fileName), before);
  const store = createSqliteSessionStore({ dbPath: join(root, "session.db") });
  const fs = createNodeFileSystemAdapter(),
    requests: ModelRequest[] = [],
    events: SessionEvent[] = [];
  const evidence: unknown[] = [];
  const readEvidence = store.readMemoryReviewEvidence.bind(store);
  store.readMemoryReviewEvidence = async (input) => {
    const page = await readEvidence(input);
    evidence.push(page);
    return page;
  };
  let turn = 1,
    username = "runtime-only-alice",
    auxiliary = 0,
    contextReads = 0;
  const model = {
    providerId: "fixture",
    modelId: "git-memory",
    displayName: "Fixture",
    optionSpecs: { maxOutputTokens: { max: 8192 }, reasoningLevel: { values: ["low"] } },
    options: { maxOutputTokens: 8192 },
    properties: {
      contextWindow: 1_000_000,
      inputFormat: { supportsText: true },
      supportsMidConversationSystem: true,
    },
    bind: () => model,
    generateText: async (request: ModelRequest) => {
      if (request.tools?.length) {
        requests.push(request);
        const text = JSON.stringify(request.messages);
        assert.match(text, new RegExp(username));
        assert.match(text, /Conventional Commits/);
        if (turn === 2) {
          assert.match(text, /排除生成的构建产物/);
          assert.doesNotMatch(text, /runtime-only-alice/);
        }
        return { text: "已确认项目 Git 提交与审核约定。", finishReason: "stop", usage: {} };
      }
      auxiliary++;
      assert.doesNotMatch(
        JSON.stringify(request.messages),
        /runtime-only-alice|runtime-only-bob|git_context/,
      );
      const payload = JSON.parse(String(request.messages[1]!.content));
      if (payload.items) {
        assert.match(String(request.messages[0]!.content), /current Host authentication/);
        return {
          text: JSON.stringify({
            decisions: payload.items.map((item: { itemId: string }) => ({
              itemId: item.itemId,
              accept: true,
              reason: "Supported adopted project Git conventions.",
            })),
          }),
          finishReason: "stop",
          usage: {},
        };
      }
      assert.match(
        String(request.messages[0]!.content),
        /Git account\/remote bindings are live Host configuration/,
      );
      const session = payload.sources.find((s: { kind: string }) => s.kind === "session");
      const memory = payload.sources.find((s: { reference: string }) => s.reference === fileName);
      assert.ok(session && memory);
      return {
        text: JSON.stringify({
          summary: "Git workflow",
          items:
            turn === 1
              ? [
                  {
                    fileName,
                    content: after,
                    reason: "User adopted review and publishing conventions.",
                    sourceIds: [session.id, memory.id],
                  },
                ]
              : [],
        }),
        finishReason: "stop",
        usage: {},
      };
    },
  } as unknown as Model;
  const runtime = new AgentRuntime(
    "sess_git_memory_fixture" as SessionId,
    {
      workingDirectory: root,
      workspacePath: root,
      mode: "yolo",
      modelSelection: { providerId: "fixture", modelId: "git-memory" },
      modelStreaming: "off",
      memory: {
        enabled: true,
        use: true,
        storageLocation: "workspace",
        cliStorageRoot: join(root, "profile", "cli"),
      },
      compact: { enabled: false },
      subagents: { enabled: false },
      mcp: { enabled: false },
      titleGeneration: { enabled: false },
      toolAllowlist: ["Read"],
    },
    {
      sessionStore: store,
      fileSystemPort: fs,
      modelFactory: () => model,
      eventStore: createInMemorySessionEventStore(),
      eventSink: {
        onSessionEvent: async (event) => {
          events.push(event);
        },
      },
      resolveGitContext: async (): Promise<GitAgentContext> => {
        contextReads++;
        return {
          status: "available",
          partial: false,
          repositories: [
            {
              workspacePath: root,
              revision: username,
              status: "available",
              partial: false,
              remotes: [
                {
                  name: "origin",
                  url: "https://example.invalid/repo.git",
                  authentication: {
                    status: "selected",
                    account: { name: username, username, provider: "gitlab" },
                  },
                },
              ],
            },
          ],
        };
      },
    },
  );
  try {
    const completed = await runtime.executeTurn(
      "确定项目 Git 规范：提交使用 Conventional Commits；审核时排除生成的构建产物；发布前检查远端与 Tag 目标。",
      undefined,
      { abortSignal: t.signal },
    );
    await runtime.drainMemoryExtractions(null);
    assert.equal(await readFile(join(memoryRoot, fileName), "utf8"), after);
    assert.equal(auxiliary, 2);
    const first = evidence[0] as { startMessageID: string; throughMessageID: string };
    await runtime.retryMemoryExtraction({
      startMessageId: first.startMessageID as never,
      boundaryMessageId: first.throughMessageID as never,
      turnId: completed.turnId,
    });
    await runtime.drainMemoryExtractions(null);
    assert.equal(auxiliary, 2, "The existing learning owner deduplicates completed evidence");
    turn = 2;
    username = "runtime-only-bob";
    await runtime.executeTurn(
      "请说明项目 Git 提交审核规范，尤其是构建产物与远端和 Tag 的检查规则。",
      undefined,
      { abortSignal: t.signal },
    );
    await runtime.drainMemoryExtractions(null);
    assert.equal(requests.length, 2);
    assert.equal(contextReads, 2);
    assert.equal((await fs.projectMemory!.listChanges(memoryRoot)).length, 1);
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /runtime-only-alice|runtime-only-bob|git_context/,
    );
    assert.doesNotMatch(
      JSON.stringify(events.filter((e) => e.type === "model_request")),
      /runtime-only-alice|runtime-only-bob|git_context/,
    );
    assert.ok(events.some((e) => e.type === "model_request"));
    assert.doesNotMatch(
      await readFile(join(memoryRoot, fileName), "utf8"),
      /runtime-only-|approvalId|accountId/,
    );
  } finally {
    runtime.beginShutdown();
    await store.close();
  }
});
