import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

/** 仅测试隔离 bare repo；按 CGI 原始字节转发，不能用文本 Git adapter 损坏 pack。 */
export async function createGitHttpFixture(
  binary: string,
  directory: string,
  authorization: string,
) {
  const requests: { path: string; authorization: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture");
    requests.push({ path: path.pathname, authorization: req.headers.authorization });
    if (req.headers.authorization !== authorization) {
      res.writeHead(401, { "WWW-Authenticate": "Basic realm=fixture" });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const child = spawn(binary, ["http-backend"], {
      cwd: directory,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_PROJECT_ROOT: directory,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: path.pathname,
        QUERY_STRING: path.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: "fixture",
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (b) => output.push(b));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(body);
    child.once("error", () => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
    child.once("close", () => {
      const result = Buffer.concat(output),
        separator = result.indexOf("\r\n\r\n");
      if (separator < 0) {
        res.writeHead(500);
        res.end();
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of result.subarray(0, separator).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon),
          value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(result.subarray(separator + 4));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
