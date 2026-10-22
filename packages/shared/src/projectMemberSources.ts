import { z } from "zod";
import { localProjectPathKey } from "./localProjects.js";
import {
  isRemoteWorkspaceIdentity,
  replaceRemoteWorkspaceIdentityPath,
} from "./remote-workspace-identity.js";

export const projectMemberSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local") }),
  z.strictObject({
    kind: z.literal("remote"),
    deviceId: z.string().trim().min(1).max(200),
    workspaceIdentity: z.string().trim().min(1).max(32768).refine(isRemoteWorkspaceIdentity),
  }),
]);
export type ProjectMemberSource = z.infer<typeof projectMemberSourceSchema>;
type Member = { path: string; source?: ProjectMemberSource };

/** 旧成员继承 origin；显式 local 绝不能随远端项目 origin 被重新解释。 */
export function projectMemberWorkspaceIdentity(
  member: Member,
  originIdentity?: string,
): string | undefined {
  if (member.source?.kind === "local") return undefined;
  if (member.source?.kind === "remote") return member.source.workspaceIdentity;
  return originIdentity
    ? (replaceRemoteWorkspaceIdentityPath(originIdentity, member.path) ?? originIdentity)
    : undefined;
}
export function projectMemberKey(member: Member, originIdentity?: string): string {
  const identity = projectMemberWorkspaceIdentity(member, originIdentity)?.trim();
  // 旧 profile 允许不透明 identity；它是 origin 的 key，不能把其所有不同路径折叠为同一成员。
  return identity && !isRemoteWorkspaceIdentity(identity)
    ? `${identity}\u0000${localProjectPathKey(member.path)}`
    : identity || localProjectPathKey(member.path);
}
export function projectMemberIsInOrigin(member: Member, originIdentity?: string): boolean {
  const identity = projectMemberWorkspaceIdentity(member, originIdentity);
  if (!originIdentity) return !identity;
  if (!isRemoteWorkspaceIdentity(originIdentity))
    return !member.source || identity === originIdentity;
  return Boolean(
    identity &&
    (replaceRemoteWorkspaceIdentityPath(identity, "/") ?? identity) ===
      (replaceRemoteWorkspaceIdentityPath(originIdentity, "/") ?? originIdentity),
  );
}
export function projectOriginFolderPaths(
  members: readonly Member[],
  anchor: string,
  originIdentity?: string,
): string[] {
  return [
    anchor,
    ...members
      .filter(
        (member) =>
          projectMemberIsInOrigin(member, originIdentity) &&
          localProjectPathKey(member.path) !== localProjectPathKey(anchor),
      )
      .map((member) => member.path),
  ];
}
