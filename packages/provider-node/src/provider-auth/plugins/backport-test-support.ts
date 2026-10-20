import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { createPluginAuthFixtureDriver } from "../plugins.js";
import type { AuthDriverContext, AuthGrant } from "../driver.js";

interface Call {
  path: string;
  body: string;
  bytes: Buffer;
  headers: IncomingHttpHeaders;
}
interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}
export async function fixture(
  t: TestContext,
  channel: string,
  route: (call: Call) => Reply | Promise<Reply>,
) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const call = { path: req.url!, body: bytes.toString(), bytes, headers: req.headers };
    calls.push(call);
    const reply = await route(call);
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
    res.end(reply.text ?? JSON.stringify(reply.json ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const driver = createPluginAuthFixtureDriver(
    channel,
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  )!;
  t.after(async () => {
    await driver.dispose?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { driver, calls };
}
export function account(initial: AuthGrant) {
  let grant = initial;
  const writes: AuthGrant[] = [];
  const context: AuthDriverContext = {
    routingSingleAttempt: true,
    read: async () => grant,
    write: async (next) => {
      writes.push(next);
      grant = next;
    },
  };
  return { context, writes, grant: () => grant };
}
