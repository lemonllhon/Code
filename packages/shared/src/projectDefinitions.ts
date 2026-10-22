import { z } from "zod";
import {
  projectMemberSourceSchema,
  projectMemberKey,
  projectMemberIsInOrigin,
} from "./projectMemberSources.js";
import { replaceRemoteWorkspaceIdentityPath } from "./remote-workspace-identity.js";
import {
  LOCAL_PROJECT_NAME_MAX_LENGTH,
  LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT,
  isSameLocalProjectPath,
  localProjectPathKey,
} from "./localProjects.js";

// 中文依据：自定义用途保存实际文字；保留旧 custom 值的读取兼容，不能继续用封闭枚举丢失用户输入。
export const projectMemberRoleSchema = z.string().trim().max(80);
export const PROJECT_MEMBER_PURPOSE_MAX_LENGTH = 1200;
export const projectMemberSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(32768),
  role: projectMemberRoleSchema.default(""),
  label: z.string().trim().max(80).default(""),
  description: z.string().trim().max(PROJECT_MEMBER_PURPOSE_MAX_LENGTH).default(""),
  enabled: z.boolean().default(true),
  source: projectMemberSourceSchema.optional(),
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export const projectMetadataShape = {
  /** 导航归档事实由设置 owner 持久化；不代表会话或 Git 工作树被归档。 */
  archivedAt: z.number().int().positive().optional(),
  /** 仅从侧栏隐藏，项目/会话/来源历史仍由原 owner 保留。 */
  sidebarHiddenAt: z.number().int().positive().optional(),
  /** 默认执行成员与历史身份锚点分离；旧项目缺省时使用原主目录。 */
  primaryMemberId: z.string().trim().min(1).max(200).optional(),
  revision: z.number().int().positive().optional(),
  description: z.string().trim().max(4000).optional(),
  members: z
    .array(projectMemberSchema)
    .min(1)
    .max(LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT)
    .optional(),
  memberOrder: z.array(z.string().min(1)).max(LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT).optional(),
};
export const projectDefinitionSchema = z
  .strictObject({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(LOCAL_PROJECT_NAME_MAX_LENGTH),
    primaryFolderPath: z.string().trim().min(1).max(32768),
    sourceFolderPaths: z
      .array(z.string().trim().min(1).max(32768))
      .min(1)
      .max(LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT),
    workspaceIdentity: z.string().trim().min(1).max(32768).optional(),
    ...projectMetadataShape,
  })
  .superRefine((project, context) => {
    const keys = project.sourceFolderPaths.map(localProjectPathKey);
    if (
      !isSameLocalProjectPath(project.primaryFolderPath, project.sourceFolderPaths[0]!) ||
      new Set(keys).size !== keys.length
    )
      context.addIssue({
        code: "custom",
        message: "Project source folders must be unique with the primary folder first",
      });
    if (project.members) {
      const memberKeys = project.members.map((member) =>
        projectMemberKey(member, project.workspaceIdentity),
      );
      const originKeys = project.members
        .filter((member) => projectMemberIsInOrigin(member, project.workspaceIdentity))
        .map((member) => localProjectPathKey(member.path));
      const ids = project.members.map((member) => member.id);
      for (const member of project.members)
        if (
          member.source?.kind === "remote" &&
          replaceRemoteWorkspaceIdentityPath(member.source.workspaceIdentity, member.path) !==
            member.source.workspaceIdentity
        )
          context.addIssue({
            code: "custom",
            message: "Remote member identity must name its canonical folder",
          });
      if (project.primaryMemberId && !ids.includes(project.primaryMemberId))
        context.addIssue({ code: "custom", message: "Primary member must belong to the project" });
      if (
        originKeys.length !== keys.length ||
        new Set(ids).size !== ids.length ||
        new Set(memberKeys).size !== memberKeys.length ||
        keys.some((key) => !originKeys.includes(key))
      )
        context.addIssue({ code: "custom", message: "Project members must match source folders" });
      if (!project.members.some((member) => member.enabled))
        context.addIssue({ code: "custom", message: "Enable at least one project member" });
      if (
        project.memberOrder &&
        (new Set(project.memberOrder).size !== ids.length ||
          project.memberOrder.length !== ids.length ||
          project.memberOrder.some((id) => !ids.includes(id)))
      )
        context.addIssue({
          code: "custom",
          message: "Project member order must contain each member once",
        });
    }
  });
export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;

/** 标记、首行与保存共用这一排序，不能由展示列表反推主目录或改变历史身份路径。 */
export function orderProjectMembers(
  members: readonly ProjectMember[],
  order: readonly string[] | undefined,
  primaryMemberId: string | undefined,
): ProjectMember[] {
  const rank = (id: string) => {
    const index = order?.indexOf(id) ?? -1;
    return index < 0 ? members.length : index;
  };
  return [...members].sort(
    (left, right) =>
      (left.id === primaryMemberId ? -1 : rank(left.id)) -
      (right.id === primaryMemberId ? -1 : rank(right.id)),
  );
}

export function reorderProjectMembers(
  members: readonly ProjectMember[],
  primaryMemberId: string | undefined,
  activeId: string,
  overId: string,
): ProjectMember[] {
  const next = orderProjectMembers(
    members,
    members.map((member) => member.id),
    primaryMemberId,
  );
  const from = next.findIndex((member) => member.id === activeId);
  const target = next.findIndex((member) => member.id === overId);
  if (from < 0 || target < 0 || activeId === primaryMemberId) return next;
  const to = primaryMemberId ? Math.max(1, target) : target;
  const [member] = next.splice(from, 1);
  next.splice(to, 0, member!);
  return next;
}
export const projectRegistrySchema = z
  .strictObject({ version: z.literal(1), projects: z.array(projectDefinitionSchema) })
  .superRefine((registry, context) => {
    const ids = registry.projects.map((project) => project.id);
    const scopes = registry.projects.map(projectDefinitionKey);
    if (new Set(ids).size !== ids.length || new Set(scopes).size !== scopes.length)
      context.addIssue({ code: "custom", message: "Duplicate project definition" });
  });
export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;
const commandBase = {
  operationId: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).max(200),
  expectedRevision: z.number().int().nonnegative().nullable(),
};
export const projectMutationRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...commandBase, type: z.literal("save"), project: projectDefinitionSchema }),
  z.strictObject({
    ...commandBase,
    type: z.literal("remove"),
    /** 旧入口没有显式定义时，在同一事务清理其导航索引。 */
    workspace: z
      .strictObject({
        workspacePath: z.string().trim().min(1),
        workspaceIdentity: z.string().trim().min(1).optional(),
      })
      .optional(),
  }),
  z.strictObject({ ...commandBase, type: z.literal("archive"), project: projectDefinitionSchema }),
  z.strictObject({ ...commandBase, type: z.literal("restore") }),
  z.strictObject({ ...commandBase, type: z.literal("hide"), project: projectDefinitionSchema }),
  z.strictObject({ ...commandBase, type: z.literal("show") }),
]);
export type ProjectMutationRequest = z.infer<typeof projectMutationRequestSchema>;
export const projectMutationResultSchema = z.strictObject({
  status: z.enum(["applied", "conflict", "validation_failed"]),
  project: projectDefinitionSchema.nullable(),
  reason: z.string().optional(),
});
export type ProjectMutationResult = z.infer<typeof projectMutationResultSchema>;
export const projectMutationReceiptsSchema = z
  .array(
    z.strictObject({
      operationId: z.string(),
      request: z.string(),
      result: projectMutationResultSchema,
    }),
  )
  .max(256);
export type ProjectMutationReceipt = z.infer<typeof projectMutationReceiptsSchema>[number];
export function projectDefinitionKey(
  project: Pick<ProjectDefinition, "workspaceIdentity" | "primaryFolderPath">,
): string {
  return project.workspaceIdentity?.trim() || localProjectPathKey(project.primaryFolderPath);
}
export function findProjectDefinition(
  projects: readonly ProjectDefinition[],
  workspacePath: string,
  workspaceIdentity?: string,
  projectId?: string,
): ProjectDefinition | undefined {
  const key = workspaceIdentity?.trim() || localProjectPathKey(workspacePath);
  // 中文依据：远端相同路径属于不同身份，旧 tab 的 projectId 也不能越过 scope 校验。
  return projects.find(
    (project) => projectDefinitionKey(project) === key && (!projectId || project.id === projectId),
  );
}
