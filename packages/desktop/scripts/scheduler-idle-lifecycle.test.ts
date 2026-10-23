import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { AutomationRepo } from "../../services/src/session/automationRepo.js";

test(
  "real Scheduler process exits only with no demand, then restarts and dispatches once",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lcode-scheduler-process-"));
    const repo = new AutomationRepo(join(root, ".lcode", "v2", "tasks-index.sqlite"));
    const children: ReturnType<typeof fork>[] = [];
    try {
      // 原 Scheduler 入口在隔离子进程运行，仅将 Electron parentPort 适配成 Node IPC。
      const bundled = join(root, "scheduler.cjs");
      await build({
        entryPoints: [resolve("packages/desktop/src/scheduler/index.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: bundled,
        logLevel: "silent",
        define: { "import.meta.url": JSON.stringify(pathToFileURL(bundled).href) },
      });
      const bootstrap = join(root, "bootstrap.cjs");
      await writeFile(
        bootstrap,
        `process.parentPort={postMessage:m=>process.send(m),on:(_e,f)=>process.on('message',data=>f({data}))};require('./scheduler.cjs');`,
      );
      const launch = () => {
        const child = fork(bootstrap, [], {
          env: { ...process.env, LCODE_DATA_BASE_DIR: root, ZCODE_DATA_BASE_DIR: root },
          execArgv: [],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          windowsHide: true,
        });
        children.push(child);
        let errors = "";
        child.stderr?.on("data", (chunk) => {
          errors += String(chunk);
        });
        const messages: { type: string; runId?: string }[] = [];
        child.on("message", (message) => messages.push(message as (typeof messages)[number]));
        const exit = once(child, "exit").then(([code]) => {
          assert.equal(code, 0, errors);
        });
        return { child, messages, exit };
      };
      await repo.ensureReady();
      const empty = launch();
      await empty.exit;
      assert.ok(empty.messages.some((m) => m.type === "scheduler-idle-exit"));

      const task = await repo.create(
        {
          title: "fixture",
          prompt: "fixture",
          cronExpr: "* * * * *",
          workspacePath: root,
          recurring: false,
        },
        { nextRunAt: Date.now() },
      );
      const active = launch();
      const dispatch = await new Promise<{ runId: string }>((resolveDispatch) => {
        active.child.on("message", (raw) => {
          const message = raw as { type: string; runId: string };
          if (message.type === "cron-dispatch-request") resolveDispatch(message);
        });
      });
      assert.equal(active.messages.filter((m) => m.type === "cron-dispatch-request").length, 1);
      // 删除定义也不能回收正在等待 Host 派发回执的进程。
      await repo.delete(task.automationId);
      active.child.send({ type: "scheduler-wake", automationId: task.automationId });
      assert.equal(active.child.exitCode, null);
      await repo.markRunOutcome(dispatch.runId, "succeeded");
      active.child.send({
        type: "cron-dispatch-result",
        runId: dispatch.runId,
        ok: true,
        sessionId: "fixture-session",
      });
      await active.exit;
      assert.equal(active.messages.filter((m) => m.type === "cron-dispatch-request").length, 1);
      assert.ok(active.messages.some((m) => m.type === "scheduler-idle-exit"));
      assert.equal((await repo.getRun(dispatch.runId))?.outcome, "succeeded");
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      repo.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
