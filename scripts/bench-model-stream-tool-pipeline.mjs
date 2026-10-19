import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { createSqliteSessionStore } from "../apps/lcode-cli/packages/adapters/src/storage/session-store.js";

const root = await mkdtemp(join(tmpdir(), "lcode-pipeline-bench-"));
const output = process.argv[2];
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const digest = (parts) =>
  createHash("sha256")
    .update(JSON.stringify(parts.map((p) => [p.id, p.type, p.text, p.metadata])))
    .digest("hex");

async function sample(count, mode, index, measureSql = false) {
  const store = createSqliteSessionStore({
    dbPath: join(root, `${mode}-${count}-${index}.sqlite`),
  });
  try {
    const sessionID = "fixture-session",
      messageID = "fixture-message";
    await store.createSession({
      id: sessionID,
      projectID: "fixture",
      slug: "fixture",
      directory: root,
      title: "fixture",
      version: "fixture",
    });
    await store.saveMessage({
      id: messageID,
      sessionID,
      role: "user",
      agent: "fixture",
      time: { created: 1 },
    });
    const parts = Array.from({ length: count }, (_, i) => ({
      id: `part-${i}`,
      sessionID,
      messageID,
      type: "reasoning",
      text: `fragment ${i}\n`,
      metadata: { signature: `signature-${i}` },
      time: { start: i + 1, end: i + 2 },
    }));
    const sql = { nextSequenceReads: 0, sessionTouches: 0, explicitCommits: 0 };
    // 仅基准插桩：不向产品接口暴露连接，也不改变 SQL 和持久性配置。
    if (measureSql) {
      const db = store.db;
      const prepare = db.prepare.bind(db),
        exec = db.exec.bind(db);
      db.prepare = (query) => {
        if (/max\(sequence\)/i.test(query)) sql.nextSequenceReads++;
        if (/update session set time_updated/i.test(query)) sql.sessionTouches++;
        return prepare(query);
      };
      db.exec = (query) => {
        if (/^commit$/i.test(query)) sql.explicitCommits++;
        return exec(query);
      };
    }
    const start = performance.now();
    const probe = new Promise((done) => setImmediate(() => done(performance.now() - start)));
    if (mode === "single") for (const part of parts) await store.savePart(part);
    else await store.saveParts({ sessionID, messageID, parts });
    const durationMs = performance.now() - start;
    const eventLoopTurnDelayMs = await probe;
    const saved = await store.messageWithParts({ sessionID, messageID });
    assert.equal(saved.parts.length, count);
    assert.equal(digest(saved.parts), digest(parts));
    return { durationMs, eventLoopTurnDelayMs, ...(measureSql ? { sql } : {}) };
  } finally {
    store.close();
  }
}

const result = {
  node: process.version,
  platform: process.platform,
  database: "real SQLite files; unchanged production durability",
  results: [],
};
try {
  for (const count of [2256, 10_000]) {
    const samples = count === 2256 ? 20 : 5;
    const warmups = count === 2256 ? 5 : 2;
    for (const mode of ["single", "batch"]) {
      for (let i = 0; i < warmups; i++) await sample(count, mode, `warm-${i}`);
      const values = [];
      for (let i = 0; i < samples; i++) values.push(await sample(count, mode, i));
      const instrumented = await sample(count, mode, "sql", true);
      const record = {
        count,
        mode,
        samples,
        warmups,
        p50Ms: percentile(
          values.map((v) => v.durationMs),
          0.5,
        ),
        p95Ms: percentile(
          values.map((v) => v.durationMs),
          0.95,
        ),
        p99Ms: percentile(
          values.map((v) => v.durationMs),
          0.99,
        ),
        eventLoopTurnDelayP95Ms: percentile(
          values.map((v) => v.eventLoopTurnDelayMs),
          0.95,
        ),
        sql: instrumented.sql,
      };
      result.results.push(record);
      console.log(JSON.stringify(record));
    }
  }
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
} finally {
  // 只清理由本脚本创建、已验证位于系统临时目录内的目录。
  assert.ok(
    resolve(root).startsWith(resolve(tmpdir()) + sep) &&
      basename(root).startsWith("lcode-pipeline-bench-"),
  );
  await rm(root, { recursive: true, force: true });
}
