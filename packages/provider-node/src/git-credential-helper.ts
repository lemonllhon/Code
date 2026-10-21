import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitCredentialResultSchema,
  LCODE_GIT_CREDENTIAL_HELPER_COMMAND,
  type GitCredentialResult,
} from "@lcode/shared";
import { gitCredentialHelperSource } from "./git-credential-helper-source.js";

export type GitCredentialResolver = (input: {
  cwd: string;
  url: string;
  transport: "http" | "ssh";
}) => Promise<GitCredentialResult>;
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** 认证仅适配原执行端口的子进程；不解析命令、不创建 Git writer 或自动重试。 */
export function createGitCredentialHelper(
  resolve: GitCredentialResolver,
  options: { isSea?: boolean } = {},
) {
  const isSea =
    options.isSea ??
    (() => {
      try {
        return process.getBuiltinModule?.("node:sea")?.isSea() === true;
      } catch {
        return false;
      }
    })();
  let closing = false,
    closePromise: Promise<void> | undefined;
  let ready:
    | Promise<{
        server: Server;
        directory: string;
        file: string;
        endpoint: string;
        capability: string;
      }>
    | undefined;
  const start = () =>
    (ready ??= (async () => {
      const capability = randomBytes(32).toString("hex");
      const directory = await mkdtemp(join(tmpdir(), "lcode-git-helper-")),
        file = join(directory, "helper.cjs");
      await writeFile(file, gitCredentialHelperSource, { mode: 0o600, flag: "wx" });
      const server = createServer(async (req, res) => {
        res.setHeader("cache-control", "no-store");
        const expected = Buffer.from("Bearer " + capability),
          actual = Buffer.from(req.headers.authorization ?? "");
        if (
          req.method !== "POST" ||
          req.url !== "/credential" ||
          req.headers.origin ||
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        ) {
          res.writeHead(403).end();
          return;
        }
        try {
          let text = "";
          for await (const chunk of req) {
            text += chunk;
            if (text.length > 32768) throw new Error("git-account-helper-unavailable");
          }
          const input = JSON.parse(text);
          if (
            typeof input.cwd !== "string" ||
            input.cwd.length > 8192 ||
            typeof input.url !== "string" ||
            input.url.length > 8192 ||
            !["http", "ssh"].includes(input.transport) ||
            [...input.url].some((char) => char.charCodeAt(0) < 32)
          )
            throw new Error("git-account-helper-unavailable");
          const result = gitCredentialResultSchema.parse(
            await resolve({ cwd: input.cwd, url: input.url, transport: input.transport }),
          );
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        } catch {
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ kind: "error", error: "git-account-credential-unavailable" }));
        }
      });
      server.requestTimeout = 65000;
      server.headersTimeout = 5000;
      server.maxConnections = 16;
      try {
        await new Promise<void>((done, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            done();
          });
        });
      } catch (error) {
        await unlink(file);
        await rmdir(directory);
        throw error;
      }
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("git-account-helper-unavailable");
      return {
        server,
        directory,
        file,
        endpoint: `http://127.0.0.1:${address.port}/credential`,
        capability,
      };
    })());
  const environment = async (sourceEnv: NodeJS.ProcessEnv = {}) => {
    if (closing) throw new Error("Git authentication execution port is closing");
    const helper = await start();
    if (closing) throw new Error("Git authentication execution port is closing");
    const set: NodeJS.ProcessEnv = {};
    // 中文依据：每次构造独立 overlay；多目标 Git 在真正请求认证时按 cwd/URL 解析，不能提前套一个账号。
    const prior = Number(sourceEnv.GIT_CONFIG_COUNT ?? 0);
    if (!Number.isSafeInteger(prior) || prior < 0 || prior > 100)
      throw new Error("git-account-invalid-environment");
    const executable = quote(process.execPath.replace(/\\/g, "/")),
      file = isSea ? LCODE_GIT_CREDENTIAL_HELPER_COMMAND : quote(helper.file.replace(/\\/g, "/"));
    const entries = [
      ["credential.helper", ""],
      ["credential.helper", `!ELECTRON_RUN_AS_NODE=1 ${executable} ${file} http`],
      ["credential.useHttpPath", "true"],
      ["http.followRedirects", "false"],
    ];
    entries.forEach(([key, value], offset) => {
      set[`GIT_CONFIG_KEY_${prior + offset}`] = key!;
      set[`GIT_CONFIG_VALUE_${prior + offset}`] = value!;
    });
    Object.assign(set, {
      GIT_CONFIG_COUNT: String(prior + entries.length),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_TRACE: "0",
      GIT_TRACE_CURL: "0",
      // Git 以变量是否存在决定 CURL_VERBOSE，字符串 0 仍会开启 HTTP 诊断。
      GIT_CURL_VERBOSE: undefined,
      GIT_TRACE_CURL_NO_DATA: undefined,
      GCM_TRACE: undefined,
      GCM_TRACE_SECRETS: "0",
      GIT_TRACE_REDACT: "1",
      GIT_TRACE2: "0",
      GIT_TRACE2_EVENT: "0",
      GIT_TRACE2_PERF: "0",
      LCODE_GIT_HELPER_ENDPOINT: helper.endpoint,
      LCODE_GIT_BINARY: sourceEnv.LCODE_GIT_BINARY ?? "git",
      LCODE_GIT_HELPER_CAPABILITY: helper.capability,
      GIT_SSH_VARIANT: "ssh",
      GIT_SSH_COMMAND: `ELECTRON_RUN_AS_NODE=1 ${executable} ${file} ssh`,
      LCODE_GIT_ORIGINAL_SSH: sourceEnv.GIT_SSH ?? "ssh",
      LCODE_GIT_ORIGINAL_SSH_COMMAND: sourceEnv.GIT_SSH_COMMAND ?? "",
    });
    return set;
  };
  return {
    environment,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      return (closePromise = (async () => {
        const helper = await ready?.catch(() => undefined);
        if (!helper) return;
        helper.server.closeAllConnections();
        await new Promise<void>((done, reject) =>
          helper.server.close((error) => (error ? reject(error) : done())),
        );
        await unlink(helper.file);
        await rmdir(helper.directory);
      })());
    },
  };
}
