import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  Event,
  ProxyChannel,
  createQueuePair,
} from "@lcode/rpc";
import type { ILCodeAgentService, IServiceAccessor } from "@lcode/services";
import {
  disposeServiceResourcesAndWait,
  installProjectNativeRoutingOwner,
  setDataBaseDir,
} from "@lcode/services/node";
import { createRemoteWorkspaceServiceCollection } from "./remoteWorkspaceServiceCollection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test(
  "remote workspace creation subscribes to native routing through the serialized RPC contract",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lcode-remote-native-rpc-"));
    setDataBaseDir(directory);
    const routed: unknown[] = [];
    const owner = installProjectNativeRoutingOwner({
      prepare: async (snapshot) => snapshot,
      call: async (request, originKey) => {
        routed.push({ request, originKey });
        if (request.callId === "failed") throw new Error("source device unavailable");
        return { kind: "directory", device: request.routeToken };
      },
    });
    const ready = deferred<void>();
    type NativeEvent = Parameters<
      ReturnType<ILCodeAgentService["onDynamicProjectNativeRequest"]>
    >[0] extends (event: infer E) => void
      ? E
      : never;
    type Response = Parameters<ILCodeAgentService["respondProjectNative"]>[0];
    const requests = new Emitter<NativeEvent>({ onWillAddFirstListener: () => ready.resolve() });
    let response = deferred<Response>();
    const agent = {
      onDynamicProjectNativeRequest: () => requests.event,
      onDynamicSessionRuntimePreferencesRequest: () => Event.None,
      respondProjectNative: async (value: Response) => response.resolve(value),
      disposeAllAndWait: async () => requests.dispose(),
      disposeAll: () => requests.dispose(),
    } satisfies Pick<
      ILCodeAgentService,
      | "onDynamicProjectNativeRequest"
      | "onDynamicSessionRuntimePreferencesRequest"
      | "respondProjectNative"
      | "disposeAll"
    > & { disposeAllAndWait(): Promise<void> };
    const [a, b] = createQueuePair();
    const server = new ChannelServer(b, "remote-native-fixture");
    server.registerChannel("agent", ProxyChannel.fromService(agent));
    const client = new ChannelClient(a);
    let collection: ReturnType<typeof createRemoteWorkspaceServiceCollection> | undefined;
    t.after(async () => {
      try {
        if (collection) await disposeServiceResourcesAndWait(collection);
      } finally {
        client.dispose();
        server.dispose();
        requests.dispose();
        owner.dispose();
        setDataBaseDir(null);
        await rm(directory, { recursive: true, force: true });
      }
    });
    const required = [
      "fileService",
      "gitService",
      "gitCheckpointService",
      "systemService",
      "terminalService",
      "lcodeTaskService",
      "lcodeSessionService",
      "fileWatcherService",
      "skillsService",
      "skillSyncService",
      "mcpSyncService",
      "pluginSyncService",
      "pluginsService",
      "pluginManagementService",
      "commandsService",
      "hooksService",
      "modelSelectionService",
      "providerSettingsService",
    ];
    const errors: unknown[] = [];
    collection = createRemoteWorkspaceServiceCollection({
      connectionServices: {
        ...Object.fromEntries(required.map((key) => [key, {}])),
        lcodeAgentService: ProxyChannel.toService<ILCodeAgentService>(client.getChannel("agent")),
      } as unknown as IServiceAccessor,
      parentPort: null,
      clientConfigService: {} as IServiceAccessor["clientConfigService"],
      promptAttachmentTransferService: {} as IServiceAccessor["promptAttachmentTransferService"],
      createReportingRemoteLCodeTaskService: (service) => service,
      createRemotePromptAttachmentTaskService: (service) => service,
      createRemotePromptAttachmentSessionService: (service) => service,
      runtimePreferencesBridge: { onError: (error) => errors.push(error) },
    });
    await ready.promise;
    for (const callId of ["success", "failed"]) {
      response = deferred<Response>();
      const request: NativeEvent = {
        requestId: `request-${callId}`,
        originKey: "origin-device:/app",
        request: {
          ownerId: "frozen-runtime-owner",
          callId,
          routeToken: "target-device-capability",
          operation: { port: "filesystem", method: "stat", args: [{ path: "/app" }] },
        },
      };
      requests.fire(request);
      assert.deepEqual(await response.promise, {
        requestId: request.requestId,
        result:
          callId === "success"
            ? { value: { kind: "directory", device: "target-device-capability" } }
            : { error: "source device unavailable" },
      });
      assert.deepEqual(routed.at(-1), { request: request.request, originKey: request.originKey });
    }
    assert.equal(routed.length, 2);
    assert.deepEqual(errors, []);
  },
);
