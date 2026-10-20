import { z } from "zod";

/** Host 的任务索引只授予恢复候选；CLI 仍须验证旧库身份与当前目标事实。 */
export const legacySessionRecoveryPlanSchema = z
  .object({
    sourceDatabasePath: z.string().min(1).max(32768),
    sessions: z.array(
      z
        .object({
          sessionId: z.string().min(1).max(1024),
          workspacePath: z.string().min(1).max(32768),
          workspaceIdentity: z.string().min(1).max(32768).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type LegacySessionRecoveryPlan = z.infer<typeof legacySessionRecoveryPlanSchema>;
