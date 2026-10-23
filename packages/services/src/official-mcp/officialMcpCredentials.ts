import { OFFICIAL_MCP_AUTH_HEADER_NAMES, type OfficialMcpAuthFailureReason } from "@lcode/shared";

interface OfficialMcpCredentialResolverDeps {
  credentialService: { load(key: string): Promise<string | null | undefined> };
}

/** 应用登录身份由既有凭据服务拥有，不读取供应商 Key 或套餐状态。 */
interface OfficialMcpCredentialSnapshot {
  activeProvider: "zai" | "bigmodel";
  jwt: string;
}

export type OfficialMcpCredentialOutcome =
  | { ok: true; snapshot: OfficialMcpCredentialSnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

async function readIdentity(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<OfficialMcpCredentialSnapshot | null> {
  const [providerValue, jwtValue] = await Promise.all([
    deps.credentialService.load("oauth:active_provider"),
    deps.credentialService.load("lcodejwttoken"),
  ]);
  const activeProvider = providerValue?.trim();
  const jwt = jwtValue?.trim();
  if ((activeProvider !== "zai" && activeProvider !== "bigmodel") || !jwt) return null;
  return { activeProvider, jwt };
}

export async function resolveOfficialMcpCredentials(
  deps: OfficialMcpCredentialResolverDeps,
): Promise<OfficialMcpCredentialOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await readIdentity(deps);
    if (!before) continue;
    const after = await readIdentity(deps);
    // 凭据服务中的登录身份可能在 await 期间切换，必须重读，避免拼接两代凭据。
    if (after && before.activeProvider === after.activeProvider && before.jwt === after.jwt) {
      return { ok: true, snapshot: after };
    }
  }
  return { ok: false, reason: "official_auth_unavailable" };
}

export function buildOfficialMcpAuthHeaders(
  snapshot: OfficialMcpCredentialSnapshot,
): Record<string, string> {
  return { [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${snapshot.jwt}` };
}

/** host 已校验来源与 workspace；上下文不参与全局登录身份的选择。 */
interface OfficialMcpAuthHeadersRequestContext {
  mcpKey: string;
  pluginId: string;
  targetOrigin: string;
  workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
}

type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/** 只合并进行中的解析；完成后丢弃快照，下次调用重新读取登录身份。 */
export function createOfficialMcpAuthHeadersResolver(deps: OfficialMcpCredentialResolverDeps): {
  resolveHeaders(
    request?: OfficialMcpAuthHeadersRequestContext,
  ): Promise<OfficialMcpAuthHeadersOutcome>;
} {
  let pending: Promise<OfficialMcpAuthHeadersOutcome> | null = null;
  return {
    resolveHeaders(_request) {
      if (pending) return pending;
      const inFlight = (async (): Promise<OfficialMcpAuthHeadersOutcome> => {
        const outcome = await resolveOfficialMcpCredentials(deps);
        return outcome.ok
          ? { ok: true, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) }
          : outcome;
      })();
      pending = inFlight;
      const clear = (): void => {
        if (pending === inFlight) pending = null;
      };
      // 双 handler 同时处理成功和失败，不派生无人等待的 rejected finally Promise。
      inFlight.then(clear, clear);
      return inFlight;
    },
  };
}
