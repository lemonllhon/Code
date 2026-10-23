import { execFile } from "node:child_process";
import { promisify } from "node:util";

type GitCredentialMetadataCommand = {
  executable: string;
  args: string[];
  input?: string;
  signal?: AbortSignal;
};
type GitCredentialMetadataResult = {
  status: "ok" | "unavailable" | "failed";
  stdout: string;
};
export type GitCredentialMetadataRunner = (
  command: GitCredentialMetadataCommand,
) => Promise<GitCredentialMetadataResult>;
const execute = promisify(execFile);

/** 元信息专用进程边界：不记录命令输出/异常，也不启动 shell 或接受秘密读取命令。 */
export const runGitCredentialMetadata: GitCredentialMetadataRunner = async (command) => {
  try {
    const pending = execute(command.executable, command.args, {
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      signal: command.signal,
    });
    pending.child.stdin?.end(command.input ?? "");
    const { stdout } = await pending;
    return { status: "ok", stdout };
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "failed",
      stdout: "",
    };
  }
};
