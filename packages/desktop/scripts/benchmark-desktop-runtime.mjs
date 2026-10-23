// 生产运行时采集器：显式隔离数据/用户目录，不读取个人连接，不把登录就绪称为任务就绪。
import { parseArgs } from "node:util";
import { mkdir, mkdtemp, writeFile, rename } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { cpus, totalmem, release, arch } from "node:os";
import { _electron } from "playwright-core";
import { tsImport } from "tsx/esm/api";

const { createProcessResourceTableReader } = await tsImport(
  "@lcode/services/resource-profiling",
  import.meta.url,
);
const readProcessTable = createProcessResourceTableReader();

const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    app: { type: "string" },
    output: { type: "string", default: ".artifacts/desktop-memory/runtime" },
    label: { type: "string", default: "current" },
    commit: { type: "string" },
    trials: { type: "string", default: "5" },
    "soak-ms": { type: "string", default: "0" },
    "ready-selector": { type: "string", default: '[data-testid="login-use-api-key-button"]' },
    "ready-kind": { type: "string", default: "login-ready" },
  },
});
const trials = Number(values.trials),
  soakMs = Number(values["soak-ms"]);
if (
  !Number.isInteger(trials) ||
  trials < 1 ||
  trials > 20 ||
  !Number.isFinite(soakMs) ||
  soakMs < 0 ||
  soakMs > 8 * 60 * 60_000
)
  throw Error("Invalid trials/soak duration");
if (values.commit && !/^[0-9a-f]{7,40}$/.test(values.commit)) throw Error("Invalid commit SHA");
if (values.app && !isAbsolute(values.app)) throw Error("--app must be absolute");
if (!values.app && !values.executable)
  throw Error("Pass --app <absolute production stage> or --executable <absolute installed app>");
if (values.executable && !isAbsolute(values.executable))
  throw Error("--executable must be absolute");
const require = createRequire(import.meta.url);
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "isolated-"));
const report = {
  label: values.label,
  declaredCommit: values.commit ?? null,
  scenario: "isolated pre-login idle; no model tasks or personal configuration",
  readiness: values["ready-kind"],
  gpu: "default; hardware acceleration not forcibly disabled",
  hardware: {
    platform: process.platform,
    arch: arch(),
    osRelease: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramBytes: totalmem(),
  },
  complete: false,
  trials: [],
  soak: [],
};
const reportPath = join(output, "runtime-report.json");
async function save() {
  await writeFile(reportPath + ".tmp", JSON.stringify(report, null, 2));
  await rename(reportPath + ".tmp", reportPath);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function snapshot(electron) {
  const [chromium, table] = await Promise.all([
    electron.evaluate(({ app }) => ({
      timestamp: Date.now(),
      processes: app
        .getAppMetrics()
        .map(({ pid, type, name, cpu, memory }) => ({ pid, type, name, cpu, memory })),
    })),
    readProcessTable(),
  ]);
  if (!table) throw Error("OS process table unavailable; full tree sample is incomplete");
  const pids = new Set([electron.process().pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of table)
      if (pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
  }
  return {
    ...chromium,
    osTree: table
      .filter((row) => pids.has(row.pid))
      .map(({ pid, ppid, rssKb, cpuTimeMs }) => ({ pid, ppid, rssKb, cpuTimeMs })),
  };
}
let electron;
try {
  for (let trial = 0; trial < trials; trial++) {
    const home = join(directory, `trial-${trial}`);
    const userData = join(home, "chromium");
    // Electron 的平台目录查询要求父目录已存在；所有平台变量都指向本次隔离目录。
    await Promise.all(
      [
        "AppData/Roaming",
        "AppData/Local",
        "config",
        "cache",
        "data",
        "Library/Application Support",
        "Library/Caches",
        "chromium/session",
      ].map((path) => mkdir(join(home, path), { recursive: true })),
    );
    for (const mode of ["cold", "warm"]) {
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData/Roaming"),
        LOCALAPPDATA: join(home, "AppData/Local"),
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_DATA_HOME: join(home, "data"),
        LCODE_DATA_BASE_DIR: home,
        LCODE_HOME: join(home, ".lcode"),
        ZCODE_DATA_BASE_DIR: undefined,
        ZCODE_HOME: undefined,
        LCODE_DESKTOP_HOME_DIR: home,
        LCODE_DESKTOP_USER_DATA_DIR: userData,
        LCODE_DESKTOP_SESSION_DATA_DIR: join(userData, "session"),
        LCODE_DESKTOP_APPLICATION_NAME: "LCode Resource Benchmark",
        LCODE_TELEMETRY_ENABLED: "0",
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        SSH_AUTH_SOCK: undefined,
        ELECTRON_RUN_AS_NODE: undefined,
        NODE_OPTIONS: undefined,
        NODE_TEST_CONTEXT: undefined,
      };
      const started = performance.now();
      electron = await _electron.launch({
        executablePath: values.executable ?? require("electron"),
        args: values.app ? [values.app] : [],
        env,
        timeout: 90_000,
      });
      const page = await electron.firstWindow();
      await page.locator(values["ready-selector"]).waitFor({ state: "visible", timeout: 90_000 });
      const readyMs = performance.now() - started;
      const build = await electron.evaluate(({ app }) => ({
        version: app.getVersion(),
        packaged: app.isPackaged,
      }));
      const observations = [];
      // readiness 已由实际 UI 确认；以下等待只定义固定采样窗口。
      for (let sample = 0; sample < 3; sample++) {
        await sleep(1000);
        observations.push(await snapshot(electron));
      }
      report.trials.push({ trial, mode, readyMs, build, observations });
      await save();
      if (trial === trials - 1 && mode === "warm" && soakMs > 0) {
        const soakStarted = performance.now();
        while (performance.now() - soakStarted < soakMs) {
          await sleep(Math.min(30_000, soakMs - (performance.now() - soakStarted)));
          report.soak.push(await snapshot(electron));
          report.soakElapsedMs = performance.now() - soakStarted;
          await save();
        }
      }
      await electron.close();
      electron = undefined;
    }
  }
  const p95 = (mode) => {
    const sorted = report.trials
      .filter((item) => item.mode === mode)
      .map((item) => item.readyMs)
      .sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  };
  report.readyP95Ms = { cold: p95("cold"), warm: p95("warm") };
  report.complete = true;
  await save();
  console.log(
    JSON.stringify({
      report: reportPath,
      complete: true,
      readiness: report.readiness,
      readyP95Ms: report.readyP95Ms,
    }),
  );
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    stage: "runtime acceptance incomplete",
  };
  await save();
  throw error;
} finally {
  await electron?.close();
}
