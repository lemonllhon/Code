// Scheduler ↔ Main 私有通道；接收侧先校验，调度数据仍以原 Repo 为权威。
import { z } from "zod";
import { modelSelectionSchema, nodeSelfResourceSampleSchema } from "@lcode/shared";

export const schedulerToMainMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cron-dispatch-request"),
      automationId: z.string().min(1),
      runId: z.string().min(1),
      prompt: z.string().min(1),
      targetTaskId: z.string().optional(),
      modelSelection: modelSelectionSchema.optional(),
      mode: z.string().optional(),
      workspacePath: z.string().min(1),
      workspaceIdentity: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scheduler-log"),
      level: z.enum(["info", "warn", "error"]),
      message: z.string(),
    })
    .strict(),
  z
    .object({ type: z.literal("scheduler-resource-sample"), sample: nodeSelfResourceSampleSchema })
    .strict(),
  z.object({ type: z.literal("scheduler-idle-exit") }).strict(),
]);
export type SchedulerToMainMessage = z.infer<typeof schedulerToMainMessageSchema>;

export const mainToSchedulerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cron-dispatch-result"),
      runId: z.string().min(1),
      ok: z.boolean(),
      taskId: z.string().optional(),
      sessionId: z.string().optional(),
      error: z.string().optional(),
      failureKind: z.enum(["transient", "permanent"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("scheduler-dispose") }).strict(),
  z.object({ type: z.literal("scheduler-wake"), automationId: z.string() }).strict(),
]);
export type MainToSchedulerMessage = z.infer<typeof mainToSchedulerMessageSchema>;
