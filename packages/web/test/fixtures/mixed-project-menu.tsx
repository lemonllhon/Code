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
  return (
    <main className="flex min-h-dvh flex-col items-start gap-4 bg-background p-4 text-foreground">
      <Input
        aria-label="Project name"
        value={project.name}
        onChange={(event) => setProject({ ...project, name: event.target.value })}
      />
      <ChatEmptyWorkspacePreviewMenu
        workspacePath={project.primaryFolderPath}
        workspaceIdentity={workspaceIdentity}
        localProjects={[project]}
        workspaceTabs={[
          {
            workspacePath: project.primaryFolderPath,
            workspaceIdentity,
            remoteSessionId: "attachment",
            label: "remote-folder",
          },
        ]}
        onSelectWorkspace={(tab) => setSelected(JSON.stringify(tab))}
        onSelectConversationWorkspace={() => {}}
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
