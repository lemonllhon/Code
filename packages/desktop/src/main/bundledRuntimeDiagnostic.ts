import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { LCODE_AGENT_RUNTIME } from "@lcode/shared";

type EntryStatus = "available" | "missing" | "not-file" | "unreadable";
type RuntimeFileProbe = (path: string) => Promise<EntryStatus>;

async function inspectReadableFile(path: string): Promise<EntryStatus> {
  try {
    if (!(await stat(path)).isFile()) return "not-file";
    await access(path, constants.R_OK);
    return "available";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
  }
}

/** 只检查当前随包目录，不把用户 env、远端缓存或开发目录算作安装完整性。 */
export async function inspectBundledAgentRuntime(
  resourcesPath: string,
  platform: string,
  inspectFile: RuntimeFileProbe = inspectReadableFile,
) {
  const runtime = LCODE_AGENT_RUNTIME;
  return Promise.all(
    [
      { kind: "native-binary", segments: runtime.resolveEntrySegments(platform) },
      { kind: "node-bundle", segments: runtime.resolveNodeBundleSegments() },
    ].map(async ({ kind, segments }) => ({
      kind,
      status: await inspectFile(join(resourcesPath, runtime.bundledResourceDir, ...segments)),
    })),
  );
}

export async function logWindowsBundledRuntimeIntegrityDiagnostic(options: {
  platform: string;
  isPackaged: boolean;
  resourcesPath: string;
  logger: { warn(message: string, context: Record<string, unknown>): void };
  inspectFile?: RuntimeFileProbe;
}): Promise<void> {
  if (options.platform !== "win32" || !options.isPackaged) return;
  const entries = await inspectBundledAgentRuntime(
    options.resourcesPath,
    options.platform,
    options.inspectFile,
  );
  // Bug 原因：旧诊断只认原生 exe，正常通过 Electron Node 执行 lcode.cjs 的安装包会误报缺失。
  // 两种入口共用 runtime descriptor；这里只改只读诊断，不改 Agent 启动优先级与环境变量语义。
  if (entries.some((entry) => entry.status === "available")) return;
  options.logger.warn("[startup] Windows bundled Agent runtime unavailable", {
    event: "desktop.runtime.bundled_unavailable",
    entries,
  });
}
