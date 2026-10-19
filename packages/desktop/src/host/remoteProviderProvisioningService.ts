import { randomUUID } from "node:crypto";
import {
  describeProviderProvisioningFailure,
  formatProviderProvisioningFailure,
  providerProvisioningFailureSchema,
  runProviderProvisioningStage,
  providerProvisioningResultSchema,
  type ProviderProvisioningResult,
} from "@lcode/shared";
import type { IProviderProvisioningTargetService, IServiceAccessor } from "@lcode/services";
import {
  getProviderProvisioningSource,
  type ProviderProvisioningSource,
} from "@lcode/services/node";
import type { ServiceCollection } from "@lcode/services";

interface RemoteProviderProvisioningExecutor {
  syncLocalToRemote(): Promise<ProviderProvisioningResult>;
}

const executors = new WeakMap<ServiceCollection, RemoteProviderProvisioningExecutor>();

/** Window Host 私有执行能力；不会随 ServiceCollection 暴露到 Renderer RPC。 */
export function getRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
): RemoteProviderProvisioningExecutor | undefined {
  return executors.get(services);
}

export function registerRemoteProviderProvisioningExecutor(
  services: ServiceCollection,
  executor: RemoteProviderProvisioningExecutor,
): void {
  executors.set(services, executor);
}

export function createRemoteProviderProvisioningExecutor(options: {
  source?: ProviderProvisioningSource;
  target?: IProviderProvisioningTargetService;
}): RemoteProviderProvisioningExecutor {
  const syncLocalToRemote = async (): Promise<ProviderProvisioningResult> => {
    const syncId = randomUUID();
    if (!options.source || !options.target) {
      return unsupportedResult(syncId, "Local/Remote Provider Provisioning capability 不可用");
    }
    try {
      const envelope = await runProviderProvisioningStage("local-envelope", () =>
        options.source!.read(syncId),
      );
      const result = await runProviderProvisioningStage("remote-request", () =>
        options.target!.apply(envelope),
      );
      // 远端/旧版本的 errorMessage 不具备脱敏保证，只保留白名单诊断字段。
      const failure = providerProvisioningFailureSchema.safeParse(result.failure);
      const rollback = providerProvisioningFailureSchema.safeParse(result.rollbackFailure);
      const normalized = {
        syncId,
        status: result.status,
        personalProviderCount: result.personalProviderCount,
        credentialCount: result.credentialCount,
        rolledBack: result.rolledBack,
        ...(result.status === "applied" || result.status === "already-applied"
          ? {}
          : {
              failure: failure.success
                ? failure.data
                : { stage: "remote-request" as const, code: "diagnostics-unavailable" as const },
              ...(rollback.success ? { rollbackFailure: rollback.data } : {}),
            }),
      };
      const checked = providerProvisioningResultSchema.safeParse(normalized);
      if (!checked.success)
        throw Object.assign(new Error("远端 Provisioning 结果格式无效"), {
          code: "LCODE_PROVISIONING_INVALID",
        });
      return checked.data;
    } catch (error) {
      const failure = describeProviderProvisioningFailure("remote-request", error);
      return {
        syncId,
        status: "failed",
        personalProviderCount: 0,
        credentialCount: 0,
        failure,
        errorMessage: formatProviderProvisioningFailure(failure),
        rolledBack: true,
      } satisfies ProviderProvisioningResult;
    }
  };

  return { syncLocalToRemote };
}

export function createRemoteProviderProvisioningExecutorFromWorkspace(options: {
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
}): RemoteProviderProvisioningExecutor {
  const source = options.sourceServices
    ? getProviderProvisioningSource(options.sourceServices)
    : undefined;
  const target = (
    options.connectionServices as IServiceAccessor & {
      providerProvisioningTargetService?: IProviderProvisioningTargetService;
    }
  ).providerProvisioningTargetService;
  return createRemoteProviderProvisioningExecutor({ source, target });
}

function unsupportedResult(syncId: string, errorMessage: string): ProviderProvisioningResult {
  return {
    syncId,
    status: "unsupported",
    personalProviderCount: 0,
    credentialCount: 0,
    errorMessage,
    failure: { stage: "registration", code: "unsupported" },
    rolledBack: false,
  };
}
