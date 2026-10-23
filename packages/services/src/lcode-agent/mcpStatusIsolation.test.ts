import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Event } from "@lcode/rpc";
import { lcodeProtocolMethods } from "@lcode/shared";
import { V4_METHODS, type CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";
import {
  createRegistryModelConfig,
  ModelConfig,
  parseProviderConfig,
  serializeRegistryModelConfig,
  type ModelSelectionView,
} from "@lcode/provider";
import { setDataBaseDir } from "../paths.js";
import { createPluginManagementService } from "../plugins/pluginManagementService.js";
import { createLCodeAgentService } from "./lcodeAgentService.js";
import { LCodeAgentProcessManager } from "./lcodeAgentProcessManager.js";
import type { LCodeProtocolClient } from "./lcodeProtocolClient.js";

function readyView(): ModelSelectionView {
  const model = createRegistryModelConfig(
    ModelConfig.fromData({
      enabled: true,
      properties: {
        contextWindow: 1000,
        requiresMfjsToolSchema: false,
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
      },
      optionSpecs: {
        reasoningLevel: { values: ["none"], map: "{}" },
        maxOutputTokens: { max: 20, map: "{}" },
      },
    }),
  );
  assert.ok(model.ok, JSON.stringify(model));
  return {
    revision: 1,
    providers: [
      {
        providerId: "fixture",
        config: parseProviderConfig({
          group: "standard-personal",
          access: { type: "api-key", apiKeys: [{ id: "key", apiKey: "synthetic" }] },
        }).toJSON(),
        models: [{ modelId: "model", config: serializeRegistryModelConfig(model.config) }],
      },
    ],
  };
}

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const)
  for (const fails of [false, true])
    test(
      `MC-01/04 ${clientMode}: pending MCP and plugin ${fails ? "failure" : "success"} preserve chat clients`,
      { timeout: 10_000 },
      async (t) => {
        const directory = await mkdtemp(join(tmpdir(), "mcp-chat-isolation-"));
        setDataBaseDir(directory);
        const chatEntered = Promise.withResolvers<void>();
        const chatDone = Promise.withResolvers<void>();
        const mcpEntered = Promise.withResolvers<void>();
        const mcpDone = Promise.withResolvers<void>();
        const pluginEntered = Promise.withResolvers<void>();
        const pluginDone = Promise.withResolvers<void>();
        const calls: Array<{ client: string; method: string; params: unknown }> = [];
        const clients = new Map<string, LCodeProtocolClient>();
        const managers = new Map<string, LCodeAgentProcessManager>();
        const managementClients = new Map<LCodeAgentProcessManager, string>();
        const workspace = {
          workspacePath: directory,
          workspaceIdentity: "fixture-workspace-one",
          remoteSessionId: "fixture-attachment-one",
        };
        const otherWorkspace = {
          ...workspace,
          workspaceIdentity: "fixture-workspace-two",
          remoteSessionId: "fixture-attachment-two",
        };
        function client(key: string): LCodeProtocolClient {
          const existing = clients.get(key);
          if (existing) return existing;
          const created = {
            isDisposed: false,
            onNotification: Event.None,
            onRequest: Event.None,
            onClose: Event.None,
            request: async (
              method: string,
              params: unknown,
              schema: { parse(value: unknown): unknown },
            ) => {
              calls.push({ client: key, method, params });
              if (method === lcodeProtocolMethods.mcpList) {
                mcpEntered.resolve();
                await mcpDone.promise;
                if (fails) throw new Error("fixture MCP handshake failed");
                return schema.parse({ statuses: {} });
              }
              if (method === lcodeProtocolMethods.pluginsInstall) {
                pluginEntered.resolve();
                await pluginDone.promise;
                if (fails) throw new Error("fixture plugin install failed");
                return schema.parse({
                  installedPlugins: [],
                  dependencyClosure: [],
                  diagnostics: [],
                });
              }
              if (method === lcodeProtocolMethods.pluginsUpdate) {
                return schema.parse({
                  installedPlugins: [],
                  dependencyClosure: [],
                  diagnostics: [],
                });
              }
              if (method === lcodeProtocolMethods.pluginsConfigure) {
                return schema.parse({ pluginId: "fixture@market", diagnostics: [] });
              }
              if (method === lcodeProtocolMethods.pluginsSetEnabled) {
                const enabled = (params as { enabled: boolean }).enabled;
                return schema.parse({
                  enabled,
                  plugin: {
                    id: "fixture@market",
                    name: "fixture",
                    enabled,
                    source: "fixture",
                    marketplace: "market",
                    skillRootCount: 0,
                    commandRootCount: 0,
                    mcpServerNames: ["fixture"],
                    rootPath: directory,
                  },
                });
              }
              assert.equal(method, V4_METHODS.command);
              const envelope = params as CommandEnvelope;
              if (envelope.commandId === "held") {
                chatEntered.resolve();
                await chatDone.promise;
              }
              return schema.parse({
                commandId: envelope.commandId,
                status: "accepted",
                revisionAtDecision: 1,
              });
            },
          } as unknown as LCodeProtocolClient;
          clients.set(key, created);
          return created;
        }
        t.mock.method(
          LCodeAgentProcessManager.prototype,
          "getClient",
          async function (this: LCodeAgentProcessManager, target: typeof workspace) {
            let managementKey = managementClients.get(this);
            if (!target.workspaceIdentity && !managementKey) {
              managementKey = `management-${managementClients.size}`;
              managementClients.set(this, managementKey);
            }
            const key = target.workspaceIdentity ?? managementKey!;
            managers.set(key, this);
            return client(key);
          },
        );
        const restart = t.mock.method(
          LCodeAgentProcessManager.prototype,
          "disposeWorkspace",
          async () => {},
        );
        const disposeAll = t.mock.method(LCodeAgentProcessManager.prototype, "disposeAll");
        const disposeAllAndWait = t.mock.method(
          LCodeAgentProcessManager.prototype,
          "disposeAllAndWait",
        );
        t.mock.method(LCodeAgentProcessManager.prototype, "markReady", () => {});
        const service = createLCodeAgentService({
          modelSelectionReadinessSource: { getView: async () => readyView() },
        });
        const plugins = createPluginManagementService({ lcodeAgentService: service });
        t.after(async () => {
          chatDone.resolve();
          mcpDone.resolve();
          pluginDone.resolve();
          await service.disposeAllAndWait();
          setDataBaseDir(null);
          await rm(directory, { recursive: true, force: true });
        });
        const send = (commandId: string, target = workspace) =>
          service.sendConversationCommandV4({
            ...target,
            clientMode,
            envelope: {
              commandId,
              clientId: "fixture",
              sessionId: commandId.includes("other") ? "other-session" : "old-session",
              type: "sendText",
              issuedAt: 1,
              payload: { text: "fixture input" },
            },
          });
        const held = send("held");
        await chatEntered.promise;
        const status = service.listMcpServerStatuses({
          ...workspace,
          mcpServers: [
            { name: "new", type: "http", url: "https://mcp.example.test/tools", headers: [] },
          ],
        });
        const statusResult = fails
          ? assert.rejects(status, /fixture MCP handshake failed/)
          : status;
        await mcpEntered.promise;
        const installing = plugins.installPlugin({
          ...workspace,
          pluginName: "fixture",
          marketplace: "market",
        });
        const installResult = fails
          ? assert.rejects(installing, /fixture plugin install failed/)
          : installing;
        await pluginEntered.promise;
        // 设置检测的慢握手不能占住会话通道；同路径不同 identity 也不能串到原会话 client。
        assert.notEqual(managers.get("management-0"), managers.get(workspace.workspaceIdentity));
        assert.notEqual(managers.get("management-1"), managers.get(workspace.workspaceIdentity));
        assert.notEqual(managers.get("management-0"), managers.get("management-1"));
        assert.equal((await send("other", otherWorkspace)).status, "accepted");
        assert.equal((await send("same-workspace-other-session")).status, "accepted");
        chatDone.resolve();
        assert.equal((await held).status, "accepted");
        mcpDone.resolve();
        await statusResult;
        pluginDone.resolve();
        await installResult;
        await plugins.updatePlugin({ ...workspace, pluginId: "fixture@market" });
        await plugins.configurePlugin({
          ...workspace,
          pluginId: "fixture@market",
          options: { mode: "v2" },
        });
        for (const enabled of [false, true])
          await plugins.setPluginEnabled({ ...workspace, pluginId: "fixture@market", enabled });
        assert.equal((await send("old-session-next-input")).status, "accepted");
        assert.equal(restart.mock.callCount(), 0);
        assert.equal(disposeAll.mock.callCount(), 0);
        assert.equal(disposeAllAndWait.mock.callCount(), 0);
        assert.equal(clients.size, 4);
        assert.ok([...clients.values()].every((entry) => !entry.isDisposed));
        const chatCalls = calls.filter(({ method }) => method === V4_METHODS.command);
        assert.equal(chatCalls.length, 4);
        assert.equal(
          chatCalls.filter(({ client: key }) => key === workspace.workspaceIdentity).length,
          3,
        );
        assert.equal(
          chatCalls.filter(({ client: key }) => key === otherWorkspace.workspaceIdentity).length,
          1,
        );
        const statusCall = calls.find(({ method }) => method === lcodeProtocolMethods.mcpList)!;
        assert.equal(statusCall.client, "management-0");
        const pluginCalls = calls.filter(({ method }) => method.startsWith("plugins/"));
        assert.equal(pluginCalls.length, 5);
        assert.ok(pluginCalls.every(({ client: key }) => key === "management-1"));
        assert.deepEqual((statusCall.params as { workspace: unknown }).workspace, {
          ...workspace,
          workspaceKey: workspace.workspaceIdentity,
        });
      },
    );
