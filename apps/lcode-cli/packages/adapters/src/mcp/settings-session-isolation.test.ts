import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpPort, McpServerConfig, McpToolCallResult } from "@lcode/contracts";
import { createMcpAdapterConnectionPool } from "./index.js";

const serverSource = `
import { createInterface } from 'node:readline';
let held;
const version = process.argv[2];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const result = () => ({ content: [{ type: 'text', text: JSON.stringify({ version, pid: process.pid }) }] });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version } });
  else if (message.method === 'tools/list') reply(message.id, { tools: ['hold', 'inspect', 'release'].map(name => ({ name, inputSchema: { type: 'object' } })) });
  else if (message.method === 'ping') reply(message.id, {});
  else if (message.method === 'tools/call') {
    const name = message.params.name;
    if (name === 'hold') held = message.id;
    else if (name === 'release') {
      if (held !== undefined) reply(held, result());
      held = undefined;
      reply(message.id, result());
    } else reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ version, pid: process.pid, held: held !== undefined }) }] });
  } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
});
`;

function evidence(result: McpToolCallResult): { version: string; pid: number; held?: boolean } {
  const block = result.content.find((entry) => entry.type === "text");
  assert.ok(block && block.type === "text" && typeof block.text === "string");
  return JSON.parse(block.text);
}

for (const isolation of [undefined, "workspace"] as const)
  test(
    `MC-02 real stdio: settings replacement/removal preserves active ${isolation ?? "session"} leases`,
    { timeout: 30_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "mcp-settings-isolation-"));
      const script = join(directory, "server.mjs");
      await writeFile(script, serverSource);
      const pool = createMcpAdapterConnectionPool({ workingDirectory: directory });
      const original = pool.acquireLease({ sessionId: "old-session" });
      const other = pool.acquireLease({ sessionId: "other-session" });
      const settings = pool.acquireLease({ leaseId: "protocol-settings" });
      const next = pool.acquireLease({ sessionId: "new-session" });
      const connectOptions = { workingDirectory: directory, workspaceIdentity: "fixture-identity" };
      const config = (version: string): McpServerConfig => ({
        type: "stdio",
        command: process.execPath,
        args: [script, version],
        protocolVersion: "legacy",
        isolation,
        timeoutMs: 5_000,
      });
      const call = (port: McpPort, toolName: string) =>
        port.callTool({ serverName: "fixture", toolName });
      let held: Promise<McpToolCallResult> | undefined;
      try {
        for (const port of [original, other, settings]) {
          const snapshot = await port.connectConfiguredServers(
            { fixture: config("v1") },
            connectOptions,
          );
          assert.equal(
            snapshot.statuses.fixture?.status,
            "connected",
            snapshot.statuses.fixture?.error,
          );
        }
        const before = evidence(await call(original, "inspect"));
        const otherBefore = evidence(await call(other, "inspect"));
        if (isolation === "workspace") assert.equal(before.pid, otherBefore.pid);
        else assert.notEqual(before.pid, otherBefore.pid);
        held = call(original, "hold");
        assert.equal(evidence(await call(original, "inspect")).held, true);
        // 同名配置的替换只改变设置 lease；在途调用和其它会话仍拥有旧连接。
        await settings.connectConfiguredServers(
          { fixture: config("v2") },
          { ...connectOptions, revalidate: true },
        );
        assert.equal(evidence(await call(settings, "inspect")).version, "v2");
        await settings.connectConfiguredServers({}, connectOptions);
        await settings.close();
        assert.deepEqual(evidence(await call(original, "inspect")), { ...before, held: true });
        assert.equal(evidence(await call(other, "inspect")).pid, otherBefore.pid);
        await next.connectConfiguredServers({ fixture: config("v2") }, connectOptions);
        assert.equal(evidence(await call(next, "inspect")).version, "v2");
        await call(original, "release");
        assert.deepEqual(evidence(await held), { version: "v1", pid: before.pid });
        assert.deepEqual(evidence(await call(original, "inspect")), before);
      } finally {
        if (held) {
          await call(original, "release").catch(() => undefined);
          await held.catch(() => undefined);
        }
        await pool.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
