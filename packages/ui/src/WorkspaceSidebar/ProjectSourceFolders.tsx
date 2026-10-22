import { useRemoteProjectDevices } from "@/hooks/useRemoteProjectDevices.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useLayoutEffect, useRef } from "react";
import { FolderPlus, GitBranch, LoaderCircle } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import {
  isSameLocalProjectPath,
  LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT,
  type ProjectMember,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ProjectSortableMember } from "./ProjectSortableMember.js";
import { useProjectEditorText } from "./projectEditorText.js";
import { ProjectFolderHint } from "./ProjectFolderHint.js";

export function ProjectSourceFolders({
  members,
  primaryPath,
  primaryMemberId,
  identityAnchorPath,
  primaryLocked,
  disabled,
  checking,
  remote = false,
  ready = true,
  errors,
  dragging,
  addTestId,
  onAdd,
  onGitRepository,
  onRemoteFolder,
  identityAnchorMemberId,
  onSetPrimary,
  onChange,
  onRemove,
  onMove,
  onReorder,
}: {
  members: ProjectMember[];
  primaryPath?: string;
  primaryMemberId?: string;
  identityAnchorPath?: string;
  primaryLocked: boolean;
  disabled: boolean;
  checking: boolean;
  remote?: boolean;
  ready?: boolean;
  errors?: Record<string, string>;
  dragging?: boolean;
  canDrop?: boolean;
  addTestId?: string;
  onAdd(): void;
  onGitRepository?(): void;
  onRemoteFolder?(): void;
  identityAnchorMemberId?: string;
  onSetPrimary?(id: string): void;
  onChange(member: ProjectMember): void;
  onRemove(id: string): void;
  onMove?(index: number, delta: number): void;
  onReorder?(activeId: string, overId: string): void;
}) {
  const text = useProjectEditorText();
  const devices = useRemoteProjectDevices();
  const { locale } = useLCodeIntl();
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // 设为主要会把原行移到首位；提交后显式显示新首行，不能让滚动锚定把标记留在视口外。
    listRef.current?.scrollTo({ top: 0 });
  }, [primaryMemberId]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <section className="space-y-2">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-ui-sm sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <span className="shrink-0">
          {text("folders")} · {members.length}
        </span>
        <ProjectFolderHint />
        <div
          className="col-span-2 ml-auto flex flex-wrap justify-end gap-1 sm:col-span-1"
          data-testid="project-folder-actions"
        >
          {onRemoteFolder ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="project-add-remote-folder"
              disabled={disabled || members.length >= LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT}
              onClick={onRemoteFolder}
            >
              {locale.startsWith("zh") ? "远程目录" : "Remote folder"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            data-testid={addTestId}
            disabled={disabled || !ready || members.length >= LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT}
            onClick={onAdd}
          >
            {checking ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <FolderPlus className="size-4" />
            )}
            {text("add")}
          </Button>
          {onGitRepository ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="project-git-repository"
              disabled={disabled || !ready}
              onClick={onGitRepository}
            >
              <GitBranch className="size-4" />
              {text("gitRepository")}
            </Button>
          ) : null}
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (!disabled && over && active.id !== over.id)
            onReorder?.(String(active.id), String(over.id));
        }}
      >
        <SortableContext
          items={members.map((member) => member.id)}
          strategy={verticalListSortingStrategy}
        >
          <div
            data-testid="project-folder-list"
            ref={listRef}
            aria-busy={checking}
            className={cn(
              "h-48 divide-y divide-border overflow-y-auto overscroll-contain rounded-xl border border-border [overflow-anchor:none]",
              dragging ? "border-border-hover bg-surface-hover" : "bg-surface",
            )}
          >
            {members.length ? (
              members.map((member, index) => (
                <ProjectSortableMember
                  key={member.id}
                  sortable={Boolean(onReorder)}
                  member={member}
                  primary={
                    primaryMemberId
                      ? member.id === primaryMemberId
                      : Boolean(primaryPath && isSameLocalProjectPath(primaryPath, member.path))
                  }
                  identityAnchor={Boolean(
                    identityAnchorMemberId
                      ? member.id === identityAnchorMemberId
                      : identityAnchorPath &&
                          isSameLocalProjectPath(identityAnchorPath, member.path),
                  )}
                  primaryLocked={primaryLocked}
                  first={index <= 1}
                  last={index === members.length - 1}
                  disabled={disabled}
                  deviceLabel={
                    member.source?.kind === "remote"
                      ? (devices?.model.devices.find(
                          (item) => item.key === (member.source as { deviceId: string }).deviceId,
                        )?.profile?.name ?? member.source.deviceId)
                      : undefined
                  }
                  remote={member.source ? member.source.kind === "remote" : remote}
                  ready={ready}
                  error={errors?.[member.id] ?? errors?.[member.path]}
                  onChange={onChange}
                  onRemove={() => onRemove(member.id)}
                  onMove={onMove ? (delta) => onMove(index, delta) : undefined}
                  onSetPrimary={onSetPrimary ? () => onSetPrimary(member.id) : undefined}
                />
              ))
            ) : (
              <p className="flex h-full items-center justify-center px-3 text-ui-sm text-foreground-subtle">
                {text("addHint")}
              </p>
            )}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  );
}
