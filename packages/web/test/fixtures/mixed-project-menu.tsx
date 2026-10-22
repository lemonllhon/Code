import { useState } from "react";
import { buildRemoteWorkspaceIdentity, type ProjectDefinition } from "@lcode/shared";
import { ChatEmptyWorkspacePreviewMenu } from "@/ChatEmptyState.js";
import { Input } from "@/components/ui/input.js";

const workspaceIdentity = buildRemoteWorkspaceIdentity("/srv/remote-folder", {
  kind: "ssh",
  host: "device.example.test",
  username: "dev",
});
const initial: ProjectDefinition = {
  id: "mixed",
  name: "Unified project",
  workspaceIdentity,
  primaryFolderPath: "/srv/remote-folder",
  sourceFolderPaths: ["/srv/remote-folder"],
  primaryMemberId: "remote",
  members: [
    {
      id: "remote",
      path: "/srv/remote-folder",
      role: "deploy",
      label: "Remote",
      description: "",
      enabled: true,
      source: { kind: "remote", deviceId: "device", workspaceIdentity },
    },
    {
      id: "local",
      path: "E:/work/local-folder",
      role: "develop",
      label: "Local",
      description: "",
      enabled: true,
      source: { kind: "local" },
    },
  ],
};

export function MixedProjectMenuFixture() {
  const [project, setProject] = useState(initial);
  const [selected, setSelected] = useState("");
  const [detached, setDetached] = useState(false);
  const conversationPath = "/fixture/conversation";
  const allowDetach = !new URLSearchParams(location.search).has("noDetach");
  return (
    <main className="flex min-h-dvh flex-col items-start gap-4 bg-background p-4 text-foreground">
      <Input
        aria-label="Project name"
        value={project.name}
        onChange={(event) => setProject({ ...project, name: event.target.value })}
      />
      <ChatEmptyWorkspacePreviewMenu
        workspacePath={detached ? conversationPath : project.primaryFolderPath}
        workspaceIdentity={detached ? undefined : workspaceIdentity}
        allowConversationWorkspaceDetach={allowDetach}
        localProjects={[project]}
        workspaceTabs={[
          {
            workspacePath: project.primaryFolderPath,
            workspaceIdentity,
            remoteSessionId: "attachment",
            label: "remote-folder",
          },
          { workspacePath: conversationPath, workspacePurpose: "conversation", label: "default" },
        ]}
        onSelectWorkspace={(tab) => {
          setSelected(JSON.stringify(tab));
          setDetached(false);
        }}
        onSelectConversationWorkspace={() => setDetached(true)}
        allowOpenWorkspace={false}
        onConnectRemote={async () => "attachment"}
        onSelectRemoteProject={async () => {}}
        onCancelRemoteProject={async () => {}}
      />
      <output data-testid="selected-project" className="sr-only">
        {selected}
      </output>
    </main>
  );
}
