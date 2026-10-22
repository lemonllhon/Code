import {
  projectMemberWorkspaceIdentity,
  remoteDeviceAuthorityKey,
  replaceRemoteWorkspaceIdentityPath,
  type ProjectDefinition,
  type ProjectMember,
} from "@lcode/shared";
import type { RemoteDevice } from "@/lib/remoteDevices.js";

/** 跨项目复用的是目录来源与用途，不能沿用另一个项目的成员 ID 或按 path 猜设备。 */
export function projectImportCandidates(
  projects: ProjectDefinition[],
  currentId: string | undefined,
  devices: RemoteDevice[] | undefined,
) {
  return projects
    .filter((project) => project.id !== currentId)
    .flatMap((project) =>
      (
        project.members ??
        project.sourceFolderPaths.map((path) => ({
          id: path,
          path,
          role: "",
          label: "",
          description: "",
          enabled: true,
        }))
      ).flatMap((candidate) => {
        const identity = projectMemberWorkspaceIdentity(candidate, project.workspaceIdentity);
        const device = identity
          ? devices?.find(
              (item) =>
                remoteDeviceAuthorityKey(item.target) ===
                replaceRemoteWorkspaceIdentityPath(identity, "/"),
            )
          : undefined;
        if (identity && !device?.profile) return [];
        const member: ProjectMember = {
          ...candidate,
          source: identity
            ? { kind: "remote", deviceId: device!.profile!.id, workspaceIdentity: identity }
            : { kind: "local" },
        };
        return [{ projectId: project.id, name: project.name, path: member.path, member }];
      }),
    );
}
