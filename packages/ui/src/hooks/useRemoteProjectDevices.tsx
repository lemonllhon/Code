import { createContext, useContext, type ReactNode } from "react";
import type { RemoteDeviceManagement } from "./useRemoteDeviceManagement.js";

const Context = createContext<{
  model: RemoteDeviceManagement;
  suspended: boolean;
  manage(): void;
} | null>(null);
export function RemoteProjectDevicesProvider({
  value,
  children,
}: {
  value: NonNullable<ReturnType<typeof useRemoteProjectDevices>>;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useRemoteProjectDevices() {
  return useContext(Context);
}
