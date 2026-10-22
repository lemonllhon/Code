import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  resolveWorkspaceKey,
  projectContextSnapshotSchema,
  replaceRemoteWorkspaceIdentityPath,
  type ProjectContextSnapshot,
  type ProjectNativeRequest,
  type ProjectNativeResult,
} from "@lcode/shared";

const endpointSchema = z.strictObject({
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().optional(),
  remoteSessionId: z.string().optional(),
  generation: z.number().int().optional(),
});
type Endpoint = z.infer<typeof endpointSchema>;
const capabilitySchema = z.strictObject({ originKey: z.string().min(1), endpoint: endpointSchema });

export function createWindowProjectNativeRouter(options: {
  resolveTarget(member: ProjectContextSnapshot["members"][number]): Promise<Endpoint>;
  execute(endpoint: Endpoint, request: ProjectNativeRequest): Promise<ProjectNativeResult>;
}) {
  const secret = randomBytes(32);
  const sign = (data: string) => createHmac("sha256", secret).update(data).digest("base64url");
  const seal = (originKey: string, endpoint: Endpoint) => {
    const data = Buffer.from(JSON.stringify({ originKey, endpoint })).toString("base64url");
    return `${data}.${sign(data)}`;
  };
  const unseal = (token: string) => {
    const [data, signature, extra] = token.split(".");
    const expected = Buffer.from(sign(data ?? ""));
    const supplied = Buffer.from(signature ?? "");
    if (
      !data ||
      extra ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw new Error("Invalid project device capability");
    return capabilitySchema.parse(JSON.parse(Buffer.from(data, "base64url").toString("utf8")));
  };
  return {
    async prepare(input: ProjectContextSnapshot): Promise<ProjectContextSnapshot> {
      const snapshot = projectContextSnapshotSchema.parse(input);
      const environment = (scope: { workspaceIdentity?: string }) =>
        scope.workspaceIdentity
          ? replaceRemoteWorkspaceIdentityPath(scope.workspaceIdentity, "/")
          : "local";
      if (new Set([environment(snapshot.origin), ...snapshot.members.map(environment)]).size <= 1)
        return snapshot;
      const originKey = resolveWorkspaceKey(snapshot.origin);
      await Promise.all(
        snapshot.members.map(async (member) => {
          const endpoint = await options.resolveTarget(member);
          member.routeToken = seal(originKey, endpoint);
          const admissionOwner = `project-admission-${crypto.randomUUID()}`;
          let status: ProjectNativeResult;
          try {
            status = await options.execute(endpoint, {
              ownerId: admissionOwner,
              callId: crypto.randomUUID(),
              routeToken: member.routeToken,
              operation: {
                port: "filesystem",
                method: "stat",
                args: [{ path: member.workspacePath }],
              },
            });
          } finally {
            await options.execute(endpoint, {
              ownerId: admissionOwner,
              callId: crypto.randomUUID(),
              routeToken: member.routeToken,
              operation: { port: "execution", method: "close", args: [] },
            });
          }
          if (
            !status ||
            typeof status !== "object" ||
            Array.isArray(status) ||
            status.kind !== "directory"
          )
            throw new Error(`${member.workspacePath}: project folder is unavailable on its device`);
        }),
      );
      const execution = snapshot.members.find(
        (member) => resolveWorkspaceKey(member) === resolveWorkspaceKey(snapshot.execution),
      );
      if (!execution) throw new Error("Primary folder is outside the accepted project members");
      snapshot.execution.routeToken = execution.routeToken;
      return snapshot;
    },
    async call(request: ProjectNativeRequest, originKey: string): Promise<ProjectNativeResult> {
      const capability = unseal(request.routeToken);
      if (capability.originKey !== originKey)
        throw new Error("Project device capability belongs to another source");
      // 令牌随 admission 固定连接代次；execute 再核对当前 attachment，禁止重连后静默切到新设备。
      return options.execute(capability.endpoint, request);
    },
  };
}
