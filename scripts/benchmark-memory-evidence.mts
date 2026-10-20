import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  MemoryEvidenceCursor,
  MessageId,
  MessagePart,
  PartId,
  ProjectId,
  SessionId,
} from "../apps/lcode-cli/packages/contracts/src/index.js";
import { createSqliteSessionStore } from "../apps/lcode-cli/packages/adapters/src/storage/session-store.js";

const SAMPLES = 30;
const WARMUP = 3;
const PAGE_CHARACTERS = 8192;
const artifact = resolve(process.argv[2] ?? ".artifacts/memory-evidence-performance-20261019");
const directory = await mkdtemp(join(tmpdir(), "memory-evidence-benchmark-"));
const results: unknown[] = [];
try {
  for (const fixture of [
    { name: "2256-parts", count: 2256, tools: 1, messages: 2 },
    { name: "10000-parts", count: 10000, tools: 1, messages: 2 },
    { name: "cumulative-tools", count: 2256, tools: 50, messages: 2 },
    { name: "long-turn", count: 2256, tools: 1, messages: 300 },
  ]) {
    const { count } = fixture;
    const store = createSqliteSessionStore({ dbPath: join(directory, `${fixture.name}.db`) });
    const sessionID = `sess_bench_${fixture.name}` as SessionId;
    try {
      await store.createSession({
        id: sessionID,
        projectID: "project_fixture" as ProjectId,
        slug: "benchmark",
        directory,
        title: "Synthetic benchmark",
        version: "1",
      });
      const start = "user" as MessageId;
      const end = "assistant" as MessageId;
      await store.saveMessage({
        id: start,
        sessionID,
        role: "user",
        agent: "build",
        time: { created: 1 },
      });
      await store.savePart({
        id: "user_text" as PartId,
        sessionID,
        messageID: start,
        type: "text",
        text: "START_FACT " + "Durable fixture context. ".repeat(1500),
      });
      for (let i = 0; i < fixture.messages - 2; i++) {
        const id = `progress_${i}` as MessageId;
        await store.saveMessage({
          id,
          sessionID,
          role: "assistant",
          agent: "build",
          mode: "build",
          parentID: start,
          time: { created: i + 2 },
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        });
        await store.savePart({
          id: `${id}_text` as PartId,
          sessionID,
          messageID: id,
          type: "text",
          text: `Visible fixture progress ${i}.`,
        });
      }
      await store.saveMessage({
        id: end,
        sessionID,
        role: "assistant",
        agent: "build",
        mode: "build",
        parentID: start,
        time: { created: fixture.messages, completed: fixture.messages + 1 },
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      const parts: MessagePart[] = Array.from({ length: count }, (_, i) => ({
        id: `reason_${i}` as PartId,
        sessionID,
        messageID: end,
        type: "reasoning",
        text: "r".repeat(1000),
        time: { start: 1 },
      }));
      for (let tool = 0; tool < fixture.tools; tool++)
        parts.push({
          id: `tool_${tool}` as PartId,
          sessionID,
          messageID: end,
          type: "tool",
          tool: "Read",
          callID: "read",
          state: {
            status: "completed",
            input: {},
            output: "TOOL_PAYLOAD".repeat(Math.ceil(50000 / fixture.tools)),
            metadata: {},
            title: "fixture",
            time: { start: 1, end: 2 },
          },
        });
      parts.push({
        id: "end_text" as PartId,
        sessionID,
        messageID: end,
        type: "text",
        text: "FINAL_FACT: complete fixture.",
      });
      await store.saveParts({ sessionID, messageID: end, parts });
      const fullTimes: number[] = [],
        pageTimes: number[] = [],
        windowTimes: number[] = [];
      const pageCallTimes: number[] = [];
      let fullReturnedBytes = 0,
        pageReturnedBytes = 0,
        maxPageBytes = 0,
        pages = 0;
      let oldCoverage = false;
      for (let iteration = -WARMUP; iteration < SAMPLES; iteration++) {
        // 每个样本使控制证明失效，测量新完成轮次的首次读取成本。
        await store.updateSession({ id: sessionID, title: `Synthetic benchmark ${iteration}` });
        const full = async () => {
          const then = performance.now();
          const messages = await store.messages({ sessionID });
          const text = messages
            .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
            .join("\n");
          const elapsed = performance.now() - then;
          if (!text.includes("START_FACT") || !text.includes("FINAL_FACT"))
            throw new Error("Full baseline lost evidence");
          if (!fullReturnedBytes) fullReturnedBytes = Buffer.byteLength(JSON.stringify(messages));
          if (iteration >= 0) fullTimes.push(elapsed);
        };
        const paged = async () => {
          const then = performance.now();
          let cursor: MemoryEvidenceCursor | undefined;
          let text = "",
            returned = 0,
            largest = 0,
            n = 0;
          do {
            const pageStarted = performance.now();
            const page = await store.readMemoryReviewEvidence({
              sessionID,
              startMessageID: start,
              throughMessageID: end,
              cursor,
              maxCharacters: PAGE_CHARACTERS,
            });
            if (iteration >= 0) pageCallTimes.push(performance.now() - pageStarted);
            if (page.status !== "ready") throw new Error("Paged evidence unavailable");
            text += page.content;
            const bytes = Buffer.byteLength(JSON.stringify(page));
            returned += bytes;
            largest = Math.max(largest, bytes);
            cursor = page.nextCursor;
            n++;
          } while (cursor);
          const elapsed = performance.now() - then;
          if (
            !text.includes("START_FACT") ||
            !text.includes("FINAL_FACT") ||
            (fixture.messages > 2 && !text.includes(`progress ${fixture.messages - 3}.`)) ||
            text.includes("TOOL_PAYLOAD")
          )
            throw new Error("Paged coverage or projection failed");
          pageReturnedBytes = returned;
          maxPageBytes = largest;
          pages = n;
          if (iteration >= 0) pageTimes.push(elapsed);
        };
        if (iteration % 2) {
          await paged();
          await full();
        } else {
          await full();
          await paged();
        }
        const then = performance.now();
        const window = await store.readTranscriptWindow({
          sessionID,
          throughMessageID: end,
          limits: { maxMessageRows: 256, maxPartRows: 1024, maxDataBytes: 262144 },
        });
        if (iteration >= 0) windowTimes.push(performance.now() - then);
        oldCoverage =
          window.messages.some((message) => message.info.id === start) && !window.truncated;
      }
      const percentile = (values: number[], quantile: number) =>
        Number(
          [...values].sort((a, b) => a - b)[Math.ceil(quantile * (values.length - 1))]!.toFixed(3),
        );
      results.push({
        fixture: fixture.name,
        parts: count,
        tools: fixture.tools,
        messages: fixture.messages,
        samples: SAMPLES,
        pageCharacters: PAGE_CHARACTERS,
        pages,
        coverage: { legacyWindow: oldCoverage, fullRead: true, paged: true },
        fullRead: {
          p50Ms: percentile(fullTimes, 0.5),
          p95Ms: percentile(fullTimes, 0.95),
          returnedBytes: fullReturnedBytes,
        },
        paged: {
          p50Ms: percentile(pageTimes, 0.5),
          p95Ms: percentile(pageTimes, 0.95),
          returnedBytes: pageReturnedBytes,
          maxPageBytes,
          pageCallP95Ms: percentile(pageCallTimes, 0.95),
          pageCallMaxMs: Math.max(...pageCallTimes),
        },
        legacyWindow: { p50Ms: percentile(windowTimes, 0.5), p95Ms: percentile(windowTimes, 0.95) },
      });
    } finally {
      store.close();
    }
  }
  await mkdir(artifact, { recursive: true });
  const report = {
    node: process.version,
    platform: process.platform,
    note: "SQLite read + visible-text projection only; no model/network. Warmup 3, alternating order, 30 samples; a DB write invalidates the proof cache before every sample. Legacy window fails coverage and is not a successful extraction baseline.",
    results,
  };
  await writeFile(join(artifact, "results.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
