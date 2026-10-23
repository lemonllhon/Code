import { z } from "zod";
const location = z.enum(["local", "oss", "minio"]);
const kind = z.enum(["git", "providers"]);
const operationId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
const backupSelectionSchema = z
  .object({
    providerIds: z.array(z.string().min(1)).max(100_000).optional(),
    accountIds: z.array(z.string().min(1)).max(100_000).optional(),
  })
  .strict()
  .refine((value) => (value.providerIds?.length ?? 0) + (value.accountIds?.length ?? 0) > 0);
export const backupRequestSchema = z
  .object({
    kind,
    operationId,
    target: z
      .object({ workspacePath: z.string().min(1), workspaceIdentity: z.string().optional() })
      .strict()
      .optional(),
    selection: backupSelectionSchema.optional(),
    locations: z.array(location).min(1).max(3).optional(),
  })
  .strict();
export const backupRestoreRequestSchema = z
  .object({
    id: z.string().min(1),
    location,
    locationRevision: z.string().min(1),
    selection: backupSelectionSchema.optional(),
    mode: z.enum(["merge", "replace"]),
    destinationPath: z.string().optional(),
    overwriteConflicts: z.boolean().optional(),
  })
  .strict();
const backupVersionSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    kind,
    targetKey: z.string().min(1),
    scope: z.string().min(1),
    createdAt: z.string().datetime(),
    label: z.string(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string(),
            type: z.enum(["provider", "account", "git"]),
          })
          .strict(),
      )
      .max(200_000),
    size: z.number().int().nonnegative(),
    location,
    locationRevision: z.string().min(1),
    keyId: z.string().min(1),
    format: z.literal(2),
    rollback: z.boolean().optional(),
  })
  .strict();
export const backupMarkerSchema = z
  .object({
    version: backupVersionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    archiveDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const backupPolicyInputSchema = z
  .object({
    localEnabled: z.boolean(),
    localDirectory: z.string().nullable(),
    retention: z
      .object({
        local: z.number().int().min(1).max(100).nullable(),
        oss: z.number().int().min(1).max(100).nullable(),
        minio: z.number().int().min(1).max(100).nullable(),
      })
      .strict(),
    providers: z
      .object({
        enabled: z.boolean(),
        intervalMinutes: z.number().int().min(5).max(1440),
        selection: backupSelectionSchema.nullable(),
        locations: z.array(location).max(3),
      })
      .strict(),
  })
  .strict();
