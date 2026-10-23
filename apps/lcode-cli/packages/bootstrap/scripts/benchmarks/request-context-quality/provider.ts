import { readFile } from "node:fs/promises";
import { AiSdkModelAdapter } from "@lcode/adapters/model";
import {
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
  parseProviderConfig,
  ModelConfigRules,
} from "@lcode/provider";
import {
  decodeLCodeBuiltinRelease,
  decodeProviderConfigFile,
  resolveNodeProviderRuntimePaths,
} from "@lcode/provider-node";
import type { ModelSelection } from "@lcode/provider";

/** 显式提供配置路径；只读并沿原公开 adapter 鉴权，不复制或导出凭据。 */
export interface EphemeralConnection {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export async function prepareProvider(selection: ModelSelection, connection?: EphemeralConnection) {
  const paths = resolveNodeProviderRuntimePaths(process.env);
  if (!paths) throw new Error("provider_paths_missing");
  const [builtinText, personalText] = await Promise.all([
    readFile(paths.lcodeBuiltinFilePath, "utf8"),
    connection ? Promise.resolve(undefined) : readFile(paths.personalFilePath, "utf8"),
  ]);
  const builtin = decodeLCodeBuiltinRelease(JSON.parse(builtinText)).config;
  const personal = connection
    ? {
        providers: new ProviderConfigMap([
          [
            selection.providerId,
            parseProviderConfig({
              group: "standard-personal",
              api: { type: "openai-responses", baseUrl: connection.baseUrl },
              access: { type: "api-key", apiKey: connection.apiKey },
              personalModelIds: [connection.modelId],
            }),
          ],
        ]),
        models: ModelConfigRules.empty(),
        providerOrder: [selection.providerId],
      }
    : decodeProviderConfigFile(JSON.parse(personalText!));
  const resolution = new ProviderConfigResolver().resolve({
    lcodeBuiltinProviders: builtin.providers,
    lcodeBuiltinProviderTemplates: builtin.providerTemplates,
    lcodeBuiltinModelRules: builtin.modelConfigRules,
    personalProviders: personal.providers,
    personalModels: personal.models,
    personalProviderOrder: personal.providerOrder,
    accountProviders: ProviderConfigMap.empty(),
  });
  const registry = new ProviderRegistry(resolution.registryProviders);
  const provider = registry.getProvider(selection.providerId)!;
  const entry = registry.getModel(selection.providerId, selection.modelId);
  if (!provider || !entry) throw new Error("selection_unavailable");
  const reasoningValues = entry.config.optionSpecs.reasoningLevel.values;
  const speedValues = entry.config.optionSpecs.speed?.values;
  const effectiveSelection: ModelSelection = {
    ...selection,
    options: {
      ...(reasoningValues?.length
        ? { reasoningLevel: reasoningValues.includes("low") ? "low" : reasoningValues[0] }
        : {}),
      ...(speedValues?.length
        ? { speed: speedValues.includes("normal") ? "normal" : speedValues[0] }
        : {}),
      ...selection.options,
    },
  };
  if (!registry.validateSelection(effectiveSelection).ok) throw new Error("selection_unavailable");
  if (provider.config.access.type !== "api-key") throw new Error("api_key_provider_required");
  if (
    !provider.config.access.apiKey &&
    !provider.config.access.apiKeys?.some((key) => key.enabled !== false && key.apiKey)
  )
    throw new Error("credential_unavailable");
  const maxOutputTokens = Math.min(2048, entry.config.optionSpecs.maxOutputTokens.max);
  const adapter = new AiSdkModelAdapter({
    // false 本身不关闭 rollout；测试态副本才关闭全部 IO 落盘。不要改进程或生产配置。
    env: { ...process.env, LCODE_RUNTIME_ENV: "test" },
    modelIoFullRetentionEnabled: false,
    retry: { maxAttempts: 1 },
  });
  return {
    selection: effectiveSelection,
    maxOutputTokens,
    model: adapter.createModel({
      ...effectiveSelection,
      providerConfig: provider.config,
      modelConfig: entry.config,
    }),
  };
}
