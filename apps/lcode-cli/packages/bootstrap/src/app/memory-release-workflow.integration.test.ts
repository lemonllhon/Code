import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeFileSystemAdapter, createSqliteSessionStore } from "@lcode/adapters";
import { AgentRuntime } from "@lcode/core";
import {
  createInMemorySessionEventStore,
  type Logger,
  type MemoryReviewEvidencePage,
  type Model,
  type ModelRequest,
  type SessionId,
} from "@lcode/contracts";

const USER_INPUT =
  "发布本次版本。先核对库存哈希；桌面 tag 推送后立即同步手机端，沿用不覆盖已有 tag 的规则。";
const BEFORE = "# 项目发布流程\n\n禁止覆盖已有 tag。\n";
const AFTER = `${BEFORE}\n发布前核对库存哈希；桌面 tag 推送后立即同步手机端。\n`;
const FILE_NAME = "release-workflow.md";
const REPORTED_OUTPUT = 5000;

for (const accept of [true, false]) {
  test(`successful release turn automatically ${accept ? "updates" : "preserves rejected"} workflow without a remember request`, async (t) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "memory-release-"));
    const memoryRoot = join(root, ".lcode", "memory");
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(memoryRoot, FILE_NAME), BEFORE);
    const store = createSqliteSessionStore({ dbPath: join(root, "session.db") });
    const fs = createNodeFileSystemAdapter();
    const requests: ModelRequest[] = [];
    const diagnostics: Array<Record<string, unknown>> = [];
    const pages: MemoryReviewEvidencePage[] = [];
    const readEvidence = store.readMemoryReviewEvidence.bind(store);
    store.readMemoryReviewEvidence = async (input) => {
      const page = await readEvidence(input);
      pages.push(page);
      return page;
    };
    const model = {
      providerId: "fixture",
      modelId: "release",
      displayName: "Fixture",
      optionSpecs: { maxOutputTokens: { max: 8192 }, reasoningLevel: { values: ["low"] } },
      options: { maxOutputTokens: 8192, reasoningLevel: "low" },
      properties: {
        contextWindow: 1_000_000,
        inputFormat: { supportsText: true },
        supportsMidConversationSystem: true,
      },
      bind: () => model,
      generateText: async (request: ModelRequest) => {
        if (request.tools?.length)
          return {
            text: "已核对库存哈希，推送桌面 tag 并同步手机端；保留既有 tag。",
            finishReason: "stop",
            usage: {},
          };
        requests.push(request);
        assert.deepEqual(request.tools, []);
        const payload = JSON.parse(String(request.messages[1]!.content));
        assert.match(String(request.messages[0]!.content), /release\/deployment workflow/u);
        if (payload.items)
          return {
            text: JSON.stringify({
              decisions: payload.items.map((item: { itemId: string }) => ({
                itemId: item.itemId,
                accept,
                reason: accept
                  ? "Supported adopted project workflow."
                  : "Fixture verifier rejects.",
              })),
            }),
            finishReason: "stop",
            usage: { outputTokens: REPORTED_OUTPUT },
          };
        const session = payload.sources.find(
          (source: { kind: string }) => source.kind === "session",
        );
        const memory = payload.sources.find(
          (source: { reference: string }) => source.reference === FILE_NAME,
        );
        assert.ok(session.content.includes(USER_INPUT));
        assert.doesNotMatch(USER_INPUT, /记忆|记住|remember/u);
        assert.equal(memory.content, BEFORE);
        return {
          text: JSON.stringify({
            summary: "Reusable release process",
            items: [
              {
                fileName: FILE_NAME,
                content: AFTER,
                reason: "Adopted release constraints in the completed user turn.",
                sourceIds: [session.id, memory.id],
              },
            ],
          }),
          finishReason: "stop",
          usage: { outputTokens: REPORTED_OUTPUT, reasoningTokens: 4000 },
        };
      },
    } as unknown as Model;
    const capture: Logger["info"] = (_message, data) => {
      if (data) diagnostics.push(data);
    };
    const logger: Logger = {
      debug: capture,
      info: capture,
      warn: capture,
      error: (message, _error, data) => capture(message, data),
      child: () => logger,
    };
    const runtime = new AgentRuntime(
      "sess_release_fixture" as SessionId,
      {
        workingDirectory: root,
        workspacePath: root,
        mode: "yolo",
        modelSelection: { providerId: "fixture", modelId: "release" },
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
        logger,
      },
    );
    try {
      const completed = await runtime.executeTurn(USER_INPUT, undefined, { abortSignal: t.signal });
      await runtime.drainMemoryExtractions(null);
      assert.equal(await readFile(join(memoryRoot, FILE_NAME), "utf8"), accept ? AFTER : BEFORE);
      assert.equal(
        requests.length,
        2,
        JSON.stringify(diagnostics.filter((d) => d.event === "memory.extraction.failed")),
      );
      assert.ok(requests.every((r) => r.options!.maxOutputTokens === 4096));
      const warnings = diagnostics.filter((d) => d.event === "memory.extraction.budget_warning");
      assert.deepEqual(
        warnings.map((d) => [d.phase, d.actual, d.limit]),
        [
          ["generation", REPORTED_OUTPUT, 4096],
          ["verification", REPORTED_OUTPUT, 4096],
        ],
      );
      assert.doesNotMatch(JSON.stringify(warnings), /发布|release-workflow\.md/u);
      const changes = await fs.projectMemory!.listChanges(memoryRoot);
      assert.equal(changes.length, accept ? 1 : 0);
      if (accept) assert.equal(changes[0]!.fileName, FILE_NAME);
      const first = pages[0]!;
      await runtime.retryMemoryExtraction({
        startMessageId: first.startMessageID,
        boundaryMessageId: first.throughMessageID,
        turnId: completed.turnId,
      });
      await runtime.drainMemoryExtractions(null);
      assert.equal(requests.length, 2, "durable evidence consumption prevents duplicate requests");
    } finally {
      runtime.beginShutdown();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
