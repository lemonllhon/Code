import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  buildRemoteWorkspaceIdentity,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type RemoteDeviceDefinition,
  type RemoteDeviceMutationResult,
} from "@lcode/shared";
import { RemoteDevicesSection } from "@/settings/RemoteDevicesSection.js";
import { useRemoteDeviceManagement } from "@/hooks/useRemoteDeviceManagement.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { WorkspaceSettingsLayer } from "@/root/WorkspaceSettingsLayer.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import {
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
} from "@/lib/remoteWorkspaceHistory.js";
import { services as defaults } from "./sidebar-file-tree-service.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const credentials = new Map<string, string>();
const receipts = new Map<string, RemoteDeviceMutationResult>();
let loseNextDeviceResponse = false;
const services = {
  ...defaults,
  credentialService: {
    ...defaults.credentialService,
    load: async () => "fixture-password",
    save: async (key: string, value: string) => {
      credentials.set(key, value);
    },
  },
  settingService: {
    ...defaults.settingService,
    get: async () => ({
      ...(await defaults.settingService.get()),
      remoteDevices: { version: 1 as const, devices: profiles },
    }),
    mutateRemoteDevice: async (request: import("@lcode/shared").RemoteDeviceMutationRequest) => {
      calls.push({
        action: request.type,
        deviceId: request.deviceId,
        operationId: request.operationId,
      });
      const receipt = receipts.get(request.operationId);
      if (receipt) return receipt;
      const previous = profiles.find((profile) => profile.id === request.deviceId);
      if ((previous?.revision ?? null) !== request.expectedRevision)
        return { status: "conflict" as const, device: previous ?? null };
      profiles = profiles.filter((profile) => profile.id !== request.deviceId);
      const saved =
        request.type === "save"
          ? {
              id: request.deviceId,
              name: request.name,
              target: request.target,
              revision: (previous?.revision ?? 0) + 1,
            }
          : null;
      if (saved) profiles.push(saved);
      const result: RemoteDeviceMutationResult = { status: "applied", device: saved };
      receipts.set(request.operationId, result);
      if (loseNextDeviceResponse) {
        loseNextDeviceResponse = false;
        throw new Error("Fixture lost device save response");
      }
      return result;
    },
  },
};
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerBaseServices(services);
const ssh = {
  kind: "ssh" as const,
  host: "example.invalid",
  username: "fixture",
  port: 22,
  passwordCredentialKey: "fixture-key",
};
const history: RemoteWorkspaceSessionEntry[] = [
  {
    kind: "remote",
    target: ssh,
    workspacePath: "/one",
    lastOpenedAt: 1,
    lastConnectionStatus: "connected",
  },
  {
    kind: "remote",
    target: ssh,
    workspacePath: "/two",
    lastOpenedAt: 1,
    lastConnectionStatus: "connected",
  },
  {
    kind: "remote",
    target: { kind: "wsl", distro: "Fixture", user: "root" },
    workspacePath: "/one",
    lastOpenedAt: 1,
    lastConnectionStatus: "connected",
  },
  {
    kind: "remote",
    target: { kind: "docker", container: "fixture-container" },
    workspacePath: "/one",
    lastOpenedAt: 1,
    lastConnectionStatus: "failed",
    lastConnectionError: "Fixture offline",
  },
].map((entry) => ({
  ...entry,
  workspaceIdentity: buildRemoteWorkspaceIdentity(
    entry.workspacePath,
    entry.target as RemoteTarget,
  ),
})) as RemoteWorkspaceSessionEntry[];
let profiles: RemoteDeviceDefinition[] = [history[0]!, history[2]!, history[3]!].map(
  (entry, i) => ({
    id: `profile-${i}`,
    name:
      entry.target.kind === "ssh"
        ? entry.target.host
        : entry.target.kind === "wsl"
          ? entry.target.distro!
          : entry.target.container,
    revision: 1,
    target: entry.target,
  }),
);
function connect(entry: RemoteWorkspaceSessionEntry) {
  const sessionId = buildWorkspaceSessionKey(entry);
  registry.registerSession({
    sessionId,
    target: createRemoteTargetFromSnapshot(entry.target, {
      password: null,
      privateKeyPassphrase: null,
    }),
    services,
    workspacePath: entry.workspacePath,
    workspaceIdentity: entry.workspaceIdentity,
  });
  registry.bindWorkspaceIdentity(entry.workspaceIdentity!, sessionId);
}
history.slice(0, 2).forEach(connect);
const calls: Record<string, unknown>[] = [];
let fail = false;
Object.assign(globalThis, {
  __remoteDevicesFixture: {
    calls,
    fail: (value: boolean) => {
      fail = value;
    },
    loseDeviceResponse: () => {
      loseNextDeviceResponse = true;
    },
    savedProfiles: () => profiles,
    credentialCount: () => credentials.size,
  },
});
function Fixture() {
  const tabs = useTabStoreApi();
  useEffect(() => {
    for (const entry of history.slice(0, 2))
      tabs.getState().addTab(entry.workspacePath, {
        workspaceIdentity: entry.workspaceIdentity,
        remoteTarget: entry.target as RemoteTarget,
        remoteSessionId: buildWorkspaceSessionKey(entry),
      });
    Object.assign(globalThis, { __remoteDeviceTabs: tabs });
  }, [tabs]);
  const management = useRemoteDeviceManagement({
    history,
    connectingKeys: [],
    logs: {
      [buildWorkspaceSessionKey(history[0]!)]: [
        {
          id: "fixture-log",
          level: "success",
          timestamp: "12:00:00",
          message: "Fixture connection ready",
        },
      ],
    },
    open: (preference) => {
      if (preference?.connectOnOpen && fail) throw new Error("Fixture reconnect failure");
      calls.push({
        action: preference?.preferredTarget ? "configure" : "new",
        host:
          preference?.preferredTarget?.kind === "ssh" ? preference.preferredTarget.host : undefined,
        auto: preference?.connectOnOpen ?? false,
        hasPassword:
          preference?.preferredTarget?.kind === "ssh" &&
          Boolean(preference.preferredTarget.password),
      });
      if (preference?.connectOnOpen) {
        const profile = preference.deviceIntent!.profile!;
        registry.registerSession({
          sessionId: `device-${profile.id}`,
          deviceId: profile.id,
          target: preference.preferredTarget,
          services,
        });
      }
    },
    reconnect: async (key, options) => {
      calls.push({ action: "reconnect", key, ...options });
      if (fail) throw new Error("Fixture reconnect failure");
      const entry = history.find((entry) => buildWorkspaceSessionKey(entry) === key)!;
      connect(entry);
    },
    disconnect: async (sessionId) => {
      calls.push({ action: "disconnect", sessionId });
      registry.unregisterSession(sessionId);
    },
    openProject: async (key) => {
      calls.push({ action: "open-project", key });
    },
    retain: () => {},
  });
  Object.assign(
    (globalThis as typeof globalThis & { __remoteDevicesFixture: object }).__remoteDevicesFixture,
    {
      saveFixtureDevice: async (reconnectOnly = false) => {
        const target: RemoteTarget = {
          kind: "ssh",
          host: "zero.invalid",
          username: "fixture",
          password: "fixture-device-secret",
          assetInstallMode: "remote-download",
          useProxy: true,
          proxyProfileId: "fixture-proxy",
        };
        if (!useRemoteWorkspaceSessionStore.getState().sessionsById["fixture-device"])
          registry.registerSession({
            sessionId: "fixture-device",
            services,
            target: { kind: "ssh", host: target.host, username: target.username },
          });
        await management.saveConnected("fixture-device", target, {
          deviceId: "fixture-zero",
          ...(reconnectOnly
            ? { reconnectOnly, profile: profiles.find((profile) => profile.id === "fixture-zero") }
            : {}),
        });
      },
    },
  );
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-8">
      {params.has("settings") ? (
        <WorkspaceSettingsLayer
          isDesktop
          remoteDevices={management}
          workspaceScopedServices={params.has("unscoped") ? undefined : services}
          captionWorkspacePath="/fixture/project"
        />
      ) : (
        <>
          <h1 className="mb-5 text-ui-xl font-medium">
            {params.has("zh") ? "远程设备" : "Remote devices"}
          </h1>
          <RemoteDevicesSection management={management} />
        </>
      )}
      <ConfirmDialogHost />
    </main>
  );
}
const dark = !params.has("light");
if (params.has("settings")) setPendingSettingsSection("remoteDevices");
document.documentElement.className = dark ? "dark theme-zai-dark" : "theme-zai-light";
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={services.broadcastService}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={params.has("zh") ? "zh-CN" : "en-US"}>
            <TooltipProvider>
              <Fixture />
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
