import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, isAbsolute, resolve } from "node:path";
import {
  DEFAULT_GIT_DISCOVERY_TIMEOUT_MS,
  getGitBinaryCandidates,
  getGitCommandEnv,
} from "../config.js";

export interface GitEnvironmentProvider {
  resolveGitBinary(): Promise<string | null>;
  createCommandEnv(): NodeJS.ProcessEnv;
}

async function canExecuteGitCandidate(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(candidate, ["--version"], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, DEFAULT_GIT_DISCOVERY_TIMEOUT_MS);

    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
async function executablePath(candidate: string, env: NodeJS.ProcessEnv) {
  if (isAbsolute(candidate)) return candidate;
  if (candidate.includes("/") || candidate.includes("\\")) return resolve(candidate);
  const path = env.PATH ?? env.Path ?? "";
  const names =
    process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe")
      ? [candidate + ".exe", candidate]
      : [candidate];
  for (const directory of path.split(delimiter).filter(Boolean))
    for (const name of names) {
      const file = join(directory.replace(/^"|"$/g, ""), name);
      try {
        await access(file, constants.X_OK);
        if ((await stat(file)).isFile()) return file;
      } catch {
        /* PATH 条目可不存在，继续检测。 */
      }
    }
  return candidate;
}

export function createGitEnvironmentProvider(options?: {
  configuredBinary?: () => Promise<string>;
}): GitEnvironmentProvider {
  let cachedGitBinaryPromise: Promise<string | null> | null = null;
  let cachedKey: string | undefined;

  return {
    async resolveGitBinary(): Promise<string | null> {
      const configured = (await options?.configuredBinary?.())?.trim() ?? "";
      if (cachedGitBinaryPromise && cachedKey === configured) {
        return await cachedGitBinaryPromise;
      }

      const env = getGitCommandEnv();
      cachedKey = configured;
      // Git binary 的探测在一次会话里不会频繁变化，
      // 这里缓存第一次探测结果，避免每个 Git RPC 都重复打一遍 `git --version`。
      const probe = (async () => {
        for (const candidate of configured ? [configured] : getGitBinaryCandidates()) {
          if (await canExecuteGitCandidate(candidate, env)) {
            return executablePath(candidate, env);
          }
        }
        return null;
      })();
      cachedGitBinaryPromise = probe;
      const result = await probe;
      // 首次缺 Git 不能把 unavailable 永久缓存；安装后或重新检测后无需重启 Host。
      if (result === null && cachedGitBinaryPromise === probe) cachedGitBinaryPromise = null;
      return result;
    },

    createCommandEnv(): NodeJS.ProcessEnv {
      return getGitCommandEnv();
    },
  };
}
