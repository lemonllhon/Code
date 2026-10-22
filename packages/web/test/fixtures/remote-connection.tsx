import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ProviderSettingsView } from "@lcode/services";
import type { IPlatformService, ProxyProfile, RemoteTarget } from "@lcode/shared";
import { RemoteConnectionDialog } from "@/SSHDialog.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import "@lcode/ui/styles.css";

const attempts: {
  target: RemoteTarget;
  requestId?: string;
  resolve(id: string): void;
  reject(error: Error): void;
}[] = [];
const cancelled: (string | undefined)[] = [];
const disposed: string[] = [];
const savedDevices: string[] = [];
let saveFailures = 0;
const aliasFixture = new URLSearchParams(location.search).get("aliases");
const connectionParams = new URLSearchParams(location.search);
const savedTarget: RemoteTarget = {
  kind: "ssh",
  host: "saved.invalid",
  username: "fixture",
  port: 2222,
  password: "fixture-password",
  useProxy: true,
  proxyProfileId: "fixture-http",
};
const platform = {
  listSSHConfigAliases: async () => {
    if (aliasFixture === "error") throw new Error("fixture alias read failure");
    return aliasFixture === "available"
      ? [{ alias: "fixture-alias", host: "fixture.invalid", port: 2222, username: "fixture" }]
      : [];
  },
  listWSLDistros: async () => [
    { name: "TestDistro", isDefault: true, state: "Running", version: 2 },
  ],
  isDockerAvailable: async () => true,
  listDockerContainers: async () => [
    { id: "123456789abc", name: "test-container", state: "running" },
  ],
  onRemoteConnectionLog: () => () => {},
  cancelPendingRemoteConnection: async (requestId?: string) => {
    cancelled.push(requestId);
  },
} as unknown as IPlatformService;
let proxyReadError = false;
let proxyView = {
  revision: 1,
  providerTemplates: [],
  providerOrder: [],
  providers: [],
  proxyProfiles: [
    {
      id: "fixture-http",
      name: "Office HTTP",
      httpProxy: "http://fixture-user:fixture-secret@proxy.invalid:8080",
    },
    {
      id: "fixture-socks",
      name: "Home SOCKS5",
      httpProxy: "socks5://fixture-user:fixture-secret@proxy.invalid:1080",
    },
  ],
} as ProviderSettingsView;
const proxyListeners = new Set<(view: ProviderSettingsView) => void>();
const services = {
  providerSettingsService: {
    getView: async () => {
      if (proxyReadError) throw new Error("fixture proxy read failure");
      return proxyView;
    },
    onDidChange: (listener: (view: ProviderSettingsView) => void) => {
      proxyListeners.add(listener);
      return { dispose: () => proxyListeners.delete(listener) };
    },
  },
} as unknown as IServiceAccessor;
// 在远端 workspace 的 ServiceProvider 中打开向导，也只能读取本机代理库。
useRemoteWorkspaceSessionStore.setState({ baseServices: services });
const remoteServices = {
  providerSettingsService: {
    getView: async () => {
      throw new Error("must not read remote proxy library");
    },
    onDidChange: () => ({ dispose() {} }),
  },
} as unknown as IServiceAccessor;
const locale = new URLSearchParams(location.search).get("lang") === "zh" ? "zh-CN" : "en-US";
Object.assign(window, {
  remoteConnectionFixture: {
    attempts,
    cancelled,
    disposed,
    savedDevices,
    failNextSave() {
      saveFailures++;
    },
    setProxies(proxyProfiles: readonly ProxyProfile[]) {
      proxyView = { ...proxyView, revision: proxyView.revision + 1, proxyProfiles };
      for (const listener of proxyListeners) listener(proxyView);
    },
    setProxyReadError(value: boolean) {
      proxyReadError = value;
    },
    succeed(index: number) {
      useRemoteWorkspaceSessionStore.getState().registerSession({
        sessionId: `session-${index}`,
        target: attempts[index]!.target,
        services: {
          ...services,
          systemService: { info: async () => ({ homedir: "/fixture" }) },
          fileService: { readdir: async () => [] },
        } as unknown as IServiceAccessor,
      });
      attempts[index]!.resolve(`session-${index}`);
    },
    dropSession(index: number) {
      useRemoteWorkspaceSessionStore.getState().unregisterSession(`session-${index}`);
    },
    fail(index: number) {
      attempts[index]!.reject(new Error(`fixture failure ${index}`));
    },
  },
});

function Fixture() {
  const [open, setOpen] = useState(connectionParams.has("auto"));
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={remoteServices}>
        <LCodeIntlProvider initialLocale={locale}>
          <TooltipProvider>
            <main className="p-4 text-ui-base">
              <output data-testid="fixture-open">{String(open)}</output>
              <RemoteConnectionDialog
                open={open}
                onOpenChange={setOpen}
                isWindowsDesktop={!connectionParams.has("unix")}
                preferredTarget={
                  connectionParams.has("prefill") || connectionParams.has("auto")
                    ? savedTarget
                    : undefined
                }
                connectOnOpen={connectionParams.has("auto")}
                onConnect={(target, requestId) =>
                  new Promise((resolve, reject) => {
                    attempts.push({ target, requestId, resolve, reject });
                  })
                }
                onCancelSession={async (sessionId) => {
                  disposed.push(sessionId);
                  useRemoteWorkspaceSessionStore.getState().unregisterSession(sessionId);
                }}
                onDeviceConnected={
                  connectionParams.has("device")
                    ? async (sessionId) => {
                        if (saveFailures > 0) {
                          saveFailures--;
                          throw new Error("fixture device save failed");
                        }
                        savedDevices.push(sessionId);
                      }
                    : undefined
                }
                onSelectProject={async () => {}}
              />
              <ConfirmDialogHost />
            </main>
          </TooltipProvider>
        </LCodeIntlProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
