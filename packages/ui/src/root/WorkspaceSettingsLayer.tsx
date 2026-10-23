import { useEffect } from "react";
import { LazySettingsPage as SettingsPage } from "@/root/LazySettingsPage.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { WorkspaceSettingsLayerProps } from "@/root/types.js";

export function WorkspaceSettingsLayer({
  remoteDevices,
  workspaceScopedServices,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  allowOpenWorkspace,
  onLogin,
  onLogout,
  user,
}: WorkspaceSettingsLayerProps) {
  useEffect(() => {
    logger.info("[Root] settings layer mounted");
    return () => {
      logger.info("[Root] settings layer unmounted");
    };
  }, []);

  return (
    <div className="absolute inset-0 z-10">
      {workspaceScopedServices ? (
        <ServiceProvider services={workspaceScopedServices}>
          <SettingsPage
            remoteDevices={remoteDevices}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={captionWorkspacePath}
            onBack={onBack}
            onCreateTask={onCreateTask}
            onOpenWorkspace={onOpenWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
          />
        </ServiceProvider>
      ) : (
        <SettingsPage
          remoteDevices={remoteDevices}
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
          captionWorkspacePath={captionWorkspacePath}
          onBack={onBack}
          onCreateTask={onCreateTask}
          onOpenWorkspace={onOpenWorkspace}
          allowOpenWorkspace={allowOpenWorkspace}
          onLogin={onLogin}
          onLogout={onLogout}
          user={user}
        />
      )}
    </div>
  );
}
