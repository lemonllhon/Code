import { Script } from "node:vm";
import { gitCredentialHelperSource } from "./git-credential-helper-source.js";

/** SEA 不能执行外部 .cjs；运行同一固定源码，argv 不拼进可执行代码。 */
export async function runGitCredentialHelper(argv: string[]): Promise<void> {
  const helperProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(helperProcess, "argv", {
    value: [process.execPath, "git-credential-helper", ...argv],
  });
  Object.defineProperty(helperProcess, "exitCode", {
    get: () => process.exitCode,
    set: (value) => {
      process.exitCode = value;
    },
  });
  const requireBuiltin = (id: string) => {
    if (!["node:http", "node:child_process", "node:path"].includes(id))
      throw new Error("git-account-helper-unavailable");
    return process.getBuiltinModule(id);
  };
  await new Script(gitCredentialHelperSource, {
    filename: "lcode-git-credential-helper",
  }).runInNewContext({ require: requireBuiltin, process: helperProcess, Buffer, URL });
}
