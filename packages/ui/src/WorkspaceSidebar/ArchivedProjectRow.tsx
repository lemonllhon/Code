import { useRef, useState } from "react";
import { ArchiveRestore, Cloud, Folder, Trash2 } from "lucide-react";
import type { ProjectDefinition } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useProjectNavigationActions } from "@/hooks/useProjectNavigationActions.js";
import { useProjectDeletion } from "@/hooks/useProjectDeletion.js";
import type { UnifiedSidebarTreeProps } from "./UnifiedSidebarTree.js";
import { logger } from "@/logger.js";
import { useSidebarText } from "./sidebarText.js";

export function ArchivedProjectRow({
  project,
  props,
}: {
  project: ProjectDefinition;
  props: UnifiedSidebarTreeProps;
}) {
  const text = useSidebarText();
  const navigateProject = useProjectNavigationActions();
  const target = {
    workspacePath: project.primaryFolderPath,
    workspaceIdentity: project.workspaceIdentity,
    localProjectId: project.id,
    label: project.name,
  };
  const { deleting, deleteProject } = useProjectDeletion(target, props);
  const pending = useRef(false);
  const [restoring, setRestoring] = useState(false);
  const restore = async () => {
    if (pending.current) return;
    pending.current = true;
    setRestoring(true);
    try {
      await navigateProject(
        {
          workspacePath: project.primaryFolderPath,
          workspaceIdentity: project.workspaceIdentity,
          localProjectId: project.id,
          label: project.name,
        },
        "restore",
      );
    } catch (error) {
      logger.error("[ArchivedProjectRow] 恢复项目失败", { error });
      toast(text("projectActionFailed"), { variant: "warning" });
    } finally {
      pending.current = false;
      setRestoring(false);
    }
  };
  return (
    <li
      data-testid={`archived-project-${project.id}`}
      className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5"
    >
      {project.workspaceIdentity ? (
        <Cloud className="size-4 shrink-0" />
      ) : (
        <Folder className="size-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui-base">{project.name}</div>
        <div
          className="truncate text-ui-xs text-foreground-subtlest"
          title={project.primaryFolderPath}
        >
          {project.primaryFolderPath}
        </div>
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={restoring || deleting}
        aria-label={text("restoreProject")}
        onClick={() => void restore()}
      >
        <ArchiveRestore className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={restoring || deleting}
        className="text-destructive"
        aria-label={text("deleteProject")}
        onClick={() => void deleteProject()}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}
