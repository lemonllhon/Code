import { z } from "zod";
import type { AppUsageSnapshot } from "./usage-stats.js";

export const usageModelAliasesSchema = z
  .record(z.string().trim().min(1).max(300), z.string().trim().min(1).max(300))
  .superRefine((aliases, ctx) => {
    if (Object.keys(aliases).length > 200)
      ctx.addIssue({ code: "custom", message: "At most 200 model aliases are supported" });
    for (const from of Object.keys(aliases)) {
      const seen = new Set([from]);
      let next: string | undefined = aliases[from];
      while (next !== undefined) {
        if (seen.has(next)) {
          ctx.addIssue({
            code: "custom",
            path: [from],
            message: "Model aliases cannot refer to themselves or form a cycle",
          });
          break;
        }
        seen.add(next);
        next = Object.hasOwn(aliases, next) ? aliases[next] : undefined;
      }
    }
  });
export type UsageModelAliases = z.infer<typeof usageModelAliasesSchema>;
export function usageModelName(id: string, aliases: UsageModelAliases = {}): string {
  const seen = new Set<string>();
  while (Object.hasOwn(aliases, id) && !seen.has(id)) {
    seen.add(id);
    id = aliases[id]!;
  }
  return id;
}

/** 别名仅聚合已计费的查询结果，不能改账本、价格或路由。 */
export function projectAppUsageAliases(
  snapshot: AppUsageSnapshot,
  aliases: UsageModelAliases,
): AppUsageSnapshot {
  if (!Object.keys(aliases).length) return snapshot;
  const models = new Map<string | null, AppUsageSnapshot["models"][number]>();
  for (const row of snapshot.models) {
    const id = row.modelId === null ? null : usageModelName(row.modelId, aliases);
    const prior = models.get(id);
    if (!prior) models.set(id, { ...row, modelId: id });
    else
      for (const key of [
        "totalTokens",
        "inputTokens",
        "outputTokens",
        "requestCount",
        "share",
      ] as const)
        prior[key] += row[key];
  }
  const ordered = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    ...snapshot,
    models: ordered,
    summary: {
      ...snapshot.summary,
      favoriteModel: ordered[0]
        ? {
            modelId: ordered[0].modelId,
            totalTokens: ordered[0].totalTokens,
            share: ordered[0].share,
          }
        : null,
    },
    dailyModelUsage: snapshot.dailyModelUsage.map((day) => {
      const groups = new Map<string | null, number>();
      for (const row of day.models) {
        const id = row.modelId === null ? null : usageModelName(row.modelId, aliases);
        groups.set(id, (groups.get(id) ?? 0) + row.totalTokens);
      }
      return {
        ...day,
        models: [...groups].map(([modelId, totalTokens]) => ({ modelId, totalTokens })),
      };
    }),
  };
}
