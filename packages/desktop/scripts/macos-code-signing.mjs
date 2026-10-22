import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const runCodesign = (command, args) => execFileAsync(command, args, { timeout: 120_000 });

/** 只封印本机可执行文件；默认 ad-hoc，不读取证书配置、不联网、不代表公证。 */
export async function signMacExecutable(
  executablePath,
  { identity = "-", hardenedRuntime = false, run = runCodesign } = {},
) {
  await run("/usr/bin/codesign", [
    "--force",
    "--sign",
    identity?.trim() || "-",
    "--timestamp=none",
    ...(hardenedRuntime ? ["--options", "runtime"] : []),
    executablePath,
  ]);
  await run("/usr/bin/codesign", ["--verify", "--strict", executablePath]);
}
