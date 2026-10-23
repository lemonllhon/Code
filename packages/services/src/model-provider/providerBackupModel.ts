import { createHash } from "node:crypto";
import { z } from "zod";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@lcode/provider-node";
import type {
  BackupRestoreRequest,
  BackupSelection,
  BackupSnapshot,
  BackupRestorePreview,
} from "../backup/contract.js";
import { accountSchema } from "./providerAccountStoreSchema.js";
import { oauthProviderId } from "./providerAccountsSource.js";
const providerBackupDataSchema = z
  .object({ version: z.literal(1), personal: z.unknown(), accounts: z.array(accountSchema) })
  .strict();
export type ProviderBackupData = {
  version: 1;
  personal: ReturnType<typeof encodeProviderConfigFile>;
  accounts: z.infer<typeof accountSchema>[];
};
export function parseProviderBackupData(value: unknown): ProviderBackupData {
  const parsed = providerBackupDataSchema.parse(value);
  const personal = encodeProviderConfigFile(decodeProviderConfigFile(parsed.personal));
  return {
    ...parsed,
    personal: {
      ...personal,
      config: {
        ...personal.config,
        providerOrder: personal.config.providerOrder ?? [],
        proxyProfiles: personal.config.proxyProfiles ?? [],
      },
    },
  };
}
export function providerBackupRevision(data: ProviderBackupData): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
function selectProviderBackup(
  data: ProviderBackupData,
  selection?: BackupSelection,
): ProviderBackupData {
  if (!selection) return data;
  const accounts = data.accounts.filter(
    (account) =>
      selection.providerIds?.includes(oauthProviderId(account.channelId)) ||
      selection.accountIds?.includes(account.connectionId),
  );
  const ids = new Set([
    ...(selection.providerIds ?? []),
    ...accounts.map((account) => oauthProviderId(account.channelId)),
  ]);
  const config = data.personal.config;
  const profileIds = new Set(
    config.providerConfigRules.providerRules
      .filter((rule) => ids.has(rule.providerId))
      .flatMap((rule) =>
        rule.config.network?.mode === "profile" ? [rule.config.network.profileId] : [],
      ),
  );
  const selected = {
    ...data,
    accounts,
    personal: {
      ...data.personal,
      config: {
        ...config,
        defaultModelSelection: undefined,
        providerOrder: config.providerOrder?.filter((id) => ids.has(id)),
        providerConfigRules: {
          providerRules: config.providerConfigRules.providerRules.filter((rule) =>
            ids.has(rule.providerId),
          ),
        },
        modelConfigRules: {
          providerModelRules: config.modelConfigRules.providerModelRules.filter((rule) =>
            ids.has(rule.providerId),
          ),
          manualProviderModelRules: config.modelConfigRules.manualProviderModelRules.filter(
            (rule) => ids.has(rule.providerId),
          ),
        },
      },
    },
  };
  selected.personal.config.proxyProfiles =
    config.proxyProfiles?.filter((profile) => profileIds.has(profile.id)) ?? [];
  return parseProviderBackupData(selected);
}
export function providerBackupSnapshot(
  data: ProviderBackupData,
  selection?: BackupSelection,
): BackupSnapshot {
  const selected = selectProviderBackup(data, selection);
  const items: BackupSnapshot["items"] =
    selected.personal.config.providerConfigRules.providerRules.map((rule) => ({
      id: rule.providerId,
      label: rule.providerName || rule.providerId,
      type: "provider",
    }));
  // 模型参数可单独覆盖内置供应商，没有 Personal 根记录也必须进入备份和恢复范围。
  for (const rule of [
    ...selected.personal.config.modelConfigRules.providerModelRules,
    ...selected.personal.config.modelConfigRules.manualProviderModelRules,
  ])
    if (!items.some((item) => item.id === rule.providerId))
      items.push({ id: rule.providerId, label: rule.providerId, type: "provider" });
  for (const account of selected.accounts) {
    const providerId = oauthProviderId(account.channelId);
    if (!items.some((item) => item.id === providerId))
      items.push({ id: providerId, label: account.channelId, type: "provider" });
    items.push({ id: account.connectionId, label: account.displayName, type: "account" });
  }
  const normalizedSelection = selection
    ? {
        ...(selection.providerIds
          ? { providerIds: [...new Set(selection.providerIds)].sort() }
          : {}),
        ...(selection.accountIds ? { accountIds: [...new Set(selection.accountIds)].sort() } : {}),
      }
    : null;
  return {
    kind: "providers",
    targetKey: "personal-providers",
    label: "Provider configuration",
    selection: normalizedSelection,
    items,
    data: selected,
  };
}
export function planProviderBackupMerge(
  current: ProviderBackupData,
  incoming: ProviderBackupData,
  snapshot: BackupSnapshot,
  request: BackupRestoreRequest,
) {
  incoming = selectProviderBackup(incoming, request.selection);
  const fullReplace =
    request.mode === "replace" && snapshot.selection === null && !request.selection;
  const currentConfig = current.personal.config;
  const incomingConfig = incoming.personal.config;
  const providerContent = (config: typeof currentConfig, id: string) => {
    const rule = config.providerConfigRules.providerRules.find((rule) => rule.providerId === id);
    const profileId =
      rule?.config.network?.mode === "profile" ? rule.config.network.profileId : null;
    return JSON.stringify({
      rule,
      models: config.modelConfigRules.providerModelRules.filter((rule) => rule.providerId === id),
      manualModels: config.modelConfigRules.manualProviderModelRules.filter(
        (rule) => rule.providerId === id,
      ),
      proxy: profileId
        ? config.proxyProfiles?.find((profile) => profile.id === profileId)
        : undefined,
    });
  };
  const rules = fullReplace
    ? new Map()
    : new Map(
        currentConfig.providerConfigRules.providerRules.map((rule) => [rule.providerId, rule]),
      );
  const accepted = new Set<string>();
  const changes: BackupRestorePreview["changes"] = [];
  for (const rule of incomingConfig.providerConfigRules.providerRules) {
    const previous = currentConfig.providerConfigRules.providerRules.find(
      (item) => item.providerId === rule.providerId,
    );
    // 相同凭据不代表模型参数和代理依赖相同；必须按供应商一致性单元判定冲突，避免合并暗中覆盖。
    const same =
      previous &&
      providerContent(currentConfig, rule.providerId) ===
        providerContent(incomingConfig, rule.providerId);
    const replace =
      fullReplace || !previous || same || request.mode === "replace" || request.overwriteConflicts;
    changes.push({
      id: rule.providerId,
      label: rule.providerName || rule.providerId,
      action: !previous ? "add" : same ? "keep" : replace ? "replace" : "keep",
    });
    if (replace) {
      rules.set(rule.providerId, rule);
      accepted.add(rule.providerId);
    }
  }
  const implicitIds = new Set(
    [
      ...incomingConfig.modelConfigRules.providerModelRules,
      ...incomingConfig.modelConfigRules.manualProviderModelRules,
    ].map((rule) => rule.providerId),
  );
  for (const id of implicitIds) {
    if (incomingConfig.providerConfigRules.providerRules.some((rule) => rule.providerId === id))
      continue;
    const existed = [
      ...currentConfig.modelConfigRules.providerModelRules,
      ...currentConfig.modelConfigRules.manualProviderModelRules,
    ].some((rule) => rule.providerId === id);
    const same = providerContent(currentConfig, id) === providerContent(incomingConfig, id);
    const replace =
      fullReplace || !existed || same || request.mode === "replace" || request.overwriteConflicts;
    changes.push({
      id,
      label: id,
      action: !existed ? "add" : same ? "keep" : replace ? "replace" : "keep",
    });
    if (replace) accepted.add(id);
  }
  if (fullReplace)
    for (const rule of currentConfig.providerConfigRules.providerRules)
      if (!rules.has(rule.providerId))
        changes.push({
          id: rule.providerId,
          label: rule.providerName || rule.providerId,
          action: "delete",
        });
  const accounts = fullReplace
    ? new Map()
    : new Map(current.accounts.map((account) => [account.connectionId, account]));
  if (!fullReplace && request.mode === "replace" && request.selection?.providerIds)
    for (const account of current.accounts)
      if (request.selection.providerIds.includes(oauthProviderId(account.channelId)))
        accounts.delete(account.connectionId);
  for (const account of incoming.accounts) {
    const previous = current.accounts.find((item) => item.connectionId === account.connectionId);
    const replace =
      fullReplace || !previous || request.mode === "replace" || request.overwriteConflicts;
    if (previous && previous.channelId !== account.channelId)
      throw new Error("Account identity conflicts with another provider channel");
    changes.push({
      id: account.connectionId,
      label: account.displayName,
      action:
        account.authorizationStatus === "expired"
          ? "reauthorize"
          : !previous
            ? "add"
            : replace
              ? "replace"
              : "keep",
    });
    if (replace) accounts.set(account.connectionId, account);
  }
  const proxies = new Map(
    (fullReplace ? [] : (currentConfig.proxyProfiles ?? [])).map((profile) => [
      profile.id,
      profile,
    ]),
  );
  const requiredProfiles = new Set(
    incomingConfig.providerConfigRules.providerRules
      .filter((rule) => accepted.has(rule.providerId))
      .flatMap((rule) =>
        rule.config.network?.mode === "profile" ? [rule.config.network.profileId] : [],
      ),
  );
  for (const profile of incomingConfig.proxyProfiles ?? []) {
    if (!fullReplace && !requiredProfiles.has(profile.id)) continue;
    const previous = proxies.get(profile.id);
    if (
      previous &&
      JSON.stringify(previous) !== JSON.stringify(profile) &&
      !request.overwriteConflicts &&
      request.mode !== "replace"
    )
      throw new Error("Proxy profile conflict; explicitly allow replacement before restoring");
    proxies.set(profile.id, profile);
  }
  const mergeModels = <T extends { providerId: string }>(
    before: readonly T[],
    after: readonly T[],
  ) => [
    ...(fullReplace ? [] : before.filter((rule) => !accepted.has(rule.providerId))),
    ...after.filter((rule) => accepted.has(rule.providerId)),
  ];
  const personal = {
    ...incoming.personal,
    config: {
      ...currentConfig,
      providerConfigRules: { providerRules: [...rules.values()] },
      providerOrder: fullReplace
        ? incomingConfig.providerOrder
        : [
            ...new Set([
              ...(currentConfig.providerOrder ?? []),
              ...(incomingConfig.providerOrder ?? []),
            ]),
          ],
      proxyProfiles: [...proxies.values()],
      modelConfigRules: {
        providerModelRules: mergeModels(
          currentConfig.modelConfigRules.providerModelRules,
          incomingConfig.modelConfigRules.providerModelRules,
        ),
        manualProviderModelRules: mergeModels(
          currentConfig.modelConfigRules.manualProviderModelRules,
          incomingConfig.modelConfigRules.manualProviderModelRules,
        ),
      },
      defaultModelSelection:
        fullReplace ||
        (snapshot.selection === null &&
          !request.selection &&
          currentConfig.defaultModelSelection === undefined)
          ? incomingConfig.defaultModelSelection
          : currentConfig.defaultModelSelection,
    },
  };
  const result = parseProviderBackupData({
    version: 1,
    personal,
    accounts: [...accounts.values()],
  });
  const warnings = [...accounts.values()]
    .filter((account) => account.authorizationStatus === "expired")
    .map((account) => `${account.displayName}: authorization is required`);
  if ((incomingConfig.proxyProfiles ?? []).some((profile) => profile.caCertPath))
    warnings.push("Custom CA file paths must be checked on this computer");
  return { data: result, changes, warnings };
}
