import { useRemoteProjectDevices } from "@/hooks/useRemoteProjectDevices.js";
import { RemoteProjectFolderPicker } from "@/WorkspaceSidebar/RemoteProjectFolderPicker.js";
import {
  projectMemberKey,
  projectMemberWorkspaceIdentity,
  projectOriginFolderPaths,
} from "@lcode/shared";
import { useRef, useState } from "react";
import {
  LOCAL_PROJECT_NAME_MAX_LENGTH,
  LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT,
  createUuid,
  TID_CREATE_PROJECT_ADD_FOLDER,
  TID_CREATE_PROJECT_DIALOG,
  TID_CREATE_PROJECT_NAME,
  TID_CREATE_PROJECT_SUBMIT,
  reorderProjectMembers,
  type LocalProjectCreateRequest,
  type ProjectMember,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useProjectFolderDrop } from "@/hooks/useProjectFolderDrop.js";
import { getPathLeaf } from "@/lib/path.js";
import { mergeLocalProjectFolderPaths } from "@/createProjectFolderDrop.js";
import { ProjectDialogContent } from "@/WorkspaceSidebar/ProjectDialogContent.js";
import { ProjectSourceFolders } from "@/WorkspaceSidebar/ProjectSourceFolders.js";
import { useProjectEditorText } from "@/WorkspaceSidebar/projectEditorText.js";
import { GitRepositoryWizard } from "@/git-workspace/GitRepositoryWizard.js";

export function ChatEmptyCreateProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (request: LocalProjectCreateRequest) => Promise<void>;
}) {
  const { intl } = useLCodeIntl();
  const text = useProjectEditorText();
  const platform = usePlatform();
  const services = useBaseWorkspaceServices();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gitWizard, setGitWizard] = useState(false);
  const [remotePicker, setRemotePicker] = useState(false);
  const remoteDevices = useRemoteProjectDevices();
  const [projectId, setProjectId] = useState(createUuid);
  const generation = useRef(0);
  const sourceFolderPaths = members.map((member) => member.path);
  const reset = () => {
    generation.current++;
    setName("");
    setNameTouched(false);
    setMembers([]);
    setSubmitting(false);
    setSelecting(false);
    setError(null);
    setGitWizard(false);
    setRemotePicker(false);
    setProjectId(createUuid());
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting) return;
    if (!nextOpen && gitWizard) {
      setGitWizard(false);
      return;
    }
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };
  const addMembers = (added: ProjectMember[]) => {
    setMembers((current) => {
      const combined = [...current];
      for (const member of added) {
        if (combined.some((item) => projectMemberKey(item) === projectMemberKey(member))) continue;
        if (combined.length >= LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT) {
          setError(text("limit"));
          break;
        }
        combined.push(member);
      }
      return combined;
    });
    if (!nameTouched && !name.trim() && added.length) setName(getPathLeaf(added[0]!.path));
  };
  const mergeFolders = (paths: string[]) => {
    const merged = mergeLocalProjectFolderPaths([], paths);
    addMembers(
      merged.paths.map((path) => ({
        id: crypto.randomUUID(),
        path,
        source: { kind: "local" },
        role: "",
        label: "",
        description: "",
        enabled: true,
      })),
    );
    if (merged.discardedForLimitCount) setError(text("limit"));
    return (
      !merged.discardedForLimitCount &&
      members.length +
        merged.addedPaths.filter(
          (path) =>
            !members.some(
              (member) =>
                projectMemberKey(member) === projectMemberKey({ path, source: { kind: "local" } }),
            ),
        ).length <=
        LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT
    );
  };
  const drop = useProjectFolderDrop({
    enabled: open && !gitWizard,
    busy: submitting || selecting,
    services,
    onFolders: (paths) => {
      mergeFolders(paths);
    },
    onError: setError,
  });
  const busy = submitting || selecting || drop.checking || gitWizard;
  const handleAddFolders = async () => {
    const token = generation.current;
    setSelecting(true);
    setError(null);
    try {
      const paths = platform.selectDirectories
        ? await platform.selectDirectories()
        : [await platform.selectDirectory()].filter((path): path is string => Boolean(path));
      if (token === generation.current && paths.length) mergeFolders(paths);
    } catch (failure) {
      if (token === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token === generation.current) setSelecting(false);
    }
  };
  const canSubmit = Boolean(name.trim() && members.some((member) => member.enabled) && !busy);
  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const primary = members[0]!;
      const workspaceIdentity = projectMemberWorkspaceIdentity(primary);
      await onCreate({
        projectId,
        name,
        sourceFolderPaths: projectOriginFolderPaths(members, primary.path, workspaceIdentity),
        members,
        workspaceIdentity,
        primaryMemberId: primary.id,
      });
      reset();
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setSubmitting(false);
    }
  };
  return (
    <Dialog open={open && !remoteDevices?.suspended} onOpenChange={handleOpenChange}>
      {remotePicker ? (
        <RemoteProjectFolderPicker
          onCancel={() => setRemotePicker(false)}
          onAdd={(member) => {
            addMembers([member]);
            setRemotePicker(false);
          }}
        />
      ) : gitWizard ? (
        <GitRepositoryWizard
          useBaseHost
          initialDirectory={
            members.find((member) => !member.source || member.source.kind === "local")?.path
          }
          onClose={() => setGitWizard(false)}
          canAddPath={(path) =>
            sourceFolderPaths.length < LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT ||
            members.some(
              (member) =>
                projectMemberKey(member) === projectMemberKey({ path, source: { kind: "local" } }),
            )
          }
          onImported={async (path) => mergeFolders([path])}
        />
      ) : (
        <ProjectDialogContent
          data-testid={TID_CREATE_PROJECT_DIALOG}
          onDragOver={drop.onDragOver}
          onDragLeave={drop.onDragLeave}
          onDrop={drop.onDrop}
        >
          <DialogHeader>
            <DialogTitle className="pr-8 text-ui-lg font-semibold">
              {intl.formatMessage({ id: "chat.empty.createProject.title" })}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {intl.formatMessage({ id: "chat.empty.createProject.description" })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <label className="block space-y-2 text-ui-sm">
              <span>{text("name")}</span>
              <Input
                autoFocus
                size="lg"
                value={name}
                maxLength={LOCAL_PROJECT_NAME_MAX_LENGTH}
                data-testid={TID_CREATE_PROJECT_NAME}
                disabled={busy}
                placeholder={text("name")}
                onChange={(event) => {
                  setNameTouched(true);
                  setName(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <ProjectSourceFolders
              members={members}
              primaryPath={sourceFolderPaths[0]}
              primaryMemberId={members[0]?.id}
              primaryLocked={false}
              disabled={busy}
              checking={selecting || drop.checking}
              dragging={drop.dragging}
              canDrop={drop.canDrop}
              addTestId={TID_CREATE_PROJECT_ADD_FOLDER}
              onRemoteFolder={() => setRemotePicker(true)}
              onAdd={() => void handleAddFolders()}
              onGitRepository={() => setGitWizard(true)}
              onSetPrimary={(id) =>
                setMembers((current) => [
                  ...current.filter((member) => member.id === id),
                  ...current.filter((member) => member.id !== id),
                ])
              }
              onReorder={(activeId, overId) =>
                setMembers((current) =>
                  reorderProjectMembers(current, current[0]?.id, activeId, overId),
                )
              }
              onChange={(next) =>
                setMembers((current) =>
                  current.map((member) => (member.id === next.id ? next : member)),
                )
              }
              onRemove={(id) => {
                setMembers(members.filter((member) => member.id !== id));
                setError(null);
              }}
            />
            {members.length > 0 && !members.some((member) => member.enabled) ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {text("noSelection")}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={() => handleOpenChange(false)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              data-testid={TID_CREATE_PROJECT_SUBMIT}
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {intl.formatMessage({ id: "chat.empty.createProject.submit" })}
            </Button>
          </DialogFooter>
        </ProjectDialogContent>
      )}
    </Dialog>
  );
}
