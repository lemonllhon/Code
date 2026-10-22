import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  IRuntimeEnvironmentService,
  ISidebarOrganizationService,
  ServiceCollection,
  type IServiceAccessor,
} from "@lcode/services";
import { setDataBaseDir, disposeServiceResourcesAndWait } from "@lcode/services/node";
import { createRemoteWorkspaceServiceCollection } from "./remoteWorkspaceServiceCollection.js";

test("the mobile remote collection registers only the connected Host environment owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-remote-env-"));
  setDataBaseDir(dir);
  t.after(async () => {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  });
  const runtime = {} as IRuntimeEnvironmentService;
  const localOrganization = {} as ISidebarOrganizationService;
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
  for (const supported of [true, false]) {
    let subscriptionsClosed = 0;
    const remote = new Proxy(
      {},
      {
        has(target, key) {
          assert.equal(
            String(key).startsWith("dispose"),
            false,
            "borrowed RPC disposal must not be inspected",
          );
          return Reflect.has(target, key);
        },
      },
    );
    const event = () => ({
      dispose: () => {
        subscriptionsClosed++;
      },
    });
    const connectionServices = {
      ...Object.fromEntries(required.map((key) => [key, remote])),
      lcodeAgentService: {
        onDynamicProjectNativeRequest: () => event,
        onDynamicSessionRuntimePreferencesRequest: () => event,
        disposeAllAndWait: async () => assert.fail("remote Agent lifecycle belongs to remote Host"),
        disposeAll: () => assert.fail("remote Agent disposal is not an RPC contract"),
      },
      ...(supported ? { runtimeEnvironmentService: runtime } : {}),
    } as unknown as IServiceAccessor;
    const collection = createRemoteWorkspaceServiceCollection({
      sourceServices: new ServiceCollection().register(
        ISidebarOrganizationService,
        localOrganization,
      ),
      connectionServices,
      parentPort: null,
      clientConfigService: {} as IServiceAccessor["clientConfigService"],
      promptAttachmentTransferService: {} as IServiceAccessor["promptAttachmentTransferService"],
      createReportingRemoteLCodeTaskService: (service) => service,
      createRemotePromptAttachmentTaskService: (service) => service,
      createRemotePromptAttachmentSessionService: (service) => service,
      runtimePreferencesBridge: { onError: (error) => assert.fail(String(error)) },
    });
    assert.equal(
      collection.getOptional(IRuntimeEnvironmentService),
      supported ? runtime : undefined,
    );
    assert.equal(
      collection.getOptional(ISidebarOrganizationService),
      localOrganization,
      "mobile remote views retain the local profile navigation owner",
    );
    await disposeServiceResourcesAndWait(collection);
    await disposeServiceResourcesAndWait(collection);
    assert.equal(subscriptionsClosed, 2, "each local forwarding subscription closes once");
  }
});
