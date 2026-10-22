import { useState, type ReactNode } from "react";
import type { IServiceAccessor } from "@lcode/services";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { RemoteProjectDevicesProvider } from "@/hooks/useRemoteProjectDevices.js";
import type { RemoteDevice } from "@/lib/remoteDevices.js";

const directoryCalls: Array<{ deviceId: string; path: string; includeHidden?: boolean }> = [];
const pendingDirectories = new Map<string, () => void>();
Object.assign(globalThis, {
  __mixedDirectoryBrowser: {
    calls: () => directoryCalls,
    release: (path: string) => pendingDirectories.get(path)?.(),
  },
});

export function MixedProjectDevicesFixture({
  services,
  children,
}: {
  services: IServiceAccessor;
  children: ReactNode;
}) {
  const sessions = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const [managing, setManaging] = useState(false);
  const devices: RemoteDevice[] = ["A", "B"].map((id) => ({
    key: id,
    target: { kind: "ssh", host: `${id.toLowerCase()}.example.test`, username: "dev" },
    profile: {
      id,
      name: `Device ${id}`,
      revision: 1,
      target: { kind: "ssh", host: `${id.toLowerCase()}.example.test`, username: "dev" },
    },
    projects: [],
    connected: Boolean(sessions[id]),
    sessionIds: sessions[id] ? [id] : [],
  }));
  const connect = async (device: RemoteDevice) => {
    const targetServices = {
      ...services,
      systemService: {
        ...services.systemService,
        info: async () => ({
          ...(await services.systemService.info()),
          homedir: new URLSearchParams(location.search).get("remoteHome") || "/app",
        }),
      },
      fileService: {
        ...services.fileService,
        resolvePath: async ({ path }: { path: string }) => path,
        readdir: async ({ path, includeHidden }: { path: string; includeHidden?: boolean }) => {
          directoryCalls.push({ deviceId: device.key, path, includeHidden });
          if (path === "/denied") throw new Error("fixture-permission-denied");
          if (path === "/slow")
            await new Promise<void>((resolve) => pendingDirectories.set(path, resolve));
          const names =
            path === "/"
              ? ["app", "bin", ...Array.from({ length: 60 }, (_, i) => `folder-${i}`)]
              : path === "/app"
                ? ["src", "projects", ".config", "README.md"]
                : [];
          return names
            .filter((name) => includeHidden || !name.startsWith("."))
            .map((name) => ({
              name,
              path: `${path === "/" ? "" : path}/${name}`,
              type: name === "README.md" ? "file" : "directory",
              isSymbolicLink: name === "bin",
            }));
        },
        stat: async ({ path }: { path: string }) => ({
          path,
          type: path === "/invalid" ? "file" : "directory",
        }),
      },
    } as IServiceAccessor;
    useRemoteWorkspaceSessionStore.getState().registerSession({
      sessionId: device.key,
      deviceId: device.key,
      target: device.target,
      services: targetServices,
    });
  };
  return (
    <RemoteProjectDevicesProvider
      value={{
        suspended: managing,
        manage: () => setManaging(true),
        model: {
          devices,
          connectingKeys: [],
          logs: {},
          onNew() {},
          onConfigure: connect,
          onReconnect: connect,
          onDisconnect: async (device) =>
            useRemoteWorkspaceSessionStore.getState().unregisterSession(device.key),
          onRemove: async () => {},
          onOpenProject: async () => {},
        },
      }}
    >
      {children}
      {managing ? (
        <div data-testid="mixed-device-settings" className="fixed inset-0 z-50 bg-background p-8">
          <p>远程设备</p>
          <button onClick={() => setManaging(false)}>返回项目配置</button>
        </div>
      ) : null}
    </RemoteProjectDevicesProvider>
  );
}
