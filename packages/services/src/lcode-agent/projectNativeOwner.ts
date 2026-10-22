import type {
  ProjectContextSnapshot,
  ProjectNativeRequest,
  ProjectNativeResult,
} from "@lcode/shared";

export interface ProjectNativeRoutingOwner {
  prepare(snapshot: ProjectContextSnapshot): Promise<ProjectContextSnapshot>;
  call(request: ProjectNativeRequest, originKey: string): Promise<ProjectNativeResult>;
}
// 每个窗口独立 Host 进程只有一个路由 owner；此处只保存端口，不保存任何已接受输入或项目快照。
let owner: ProjectNativeRoutingOwner | undefined;
export function installProjectNativeRoutingOwner(next: ProjectNativeRoutingOwner): {
  dispose(): void;
} {
  if (owner) throw new Error("Project native routing owner already installed");
  owner = next;
  return {
    dispose() {
      if (owner === next) owner = undefined;
    },
  };
}
export function getProjectNativeRoutingOwner(): ProjectNativeRoutingOwner | undefined {
  return owner;
}
export async function prepareNativeProjectContext(
  snapshot: ProjectContextSnapshot | null,
): Promise<ProjectContextSnapshot | null> {
  return snapshot && owner ? owner.prepare(snapshot) : snapshot;
}
