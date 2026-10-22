import { z } from "zod";
import { buildRemoteWorkspaceIdentity } from "./remote-workspace-identity.js";
import type { RemoteTarget } from "./remoteTarget.js";
import {
  sshConnectOptionsSchema,
  wslConnectOptionsSchema,
  dockerConnectOptionsSchema,
} from "./remoteTargetSchema.js";

const text = z.string().trim().min(1).max(32768);
/** 设备归属按既有远端 authority 计算，认证方式、代理和资源下载方式不是另一台设备。 */
export function remoteDeviceAuthorityKey(target: RemoteTarget): string {
  return buildRemoteWorkspaceIdentity("/", target);
}
export const remoteDeviceTargetSchema = z.discriminatedUnion("kind", [
  sshConnectOptionsSchema
    .omit({ password: true, privateKeyPassphrase: true })
    .extend({
      passwordCredentialKey: text.optional(),
      privateKeyPassphraseCredentialKey: text.optional(),
    })
    .strict(),
  wslConnectOptionsSchema.strict(),
  dockerConnectOptionsSchema.strict(),
]);
export const remoteDeviceDefinitionSchema = z.strictObject({
  id: text,
  name: z.string().trim().min(1).max(200),
  revision: z.number().int().positive(),
  target: remoteDeviceTargetSchema,
});
export type RemoteDeviceDefinition = z.infer<typeof remoteDeviceDefinitionSchema>;
export const remoteDeviceRegistrySchema = z
  .strictObject({
    version: z.literal(1),
    devices: z.array(remoteDeviceDefinitionSchema).max(200),
  })
  .superRefine((registry, context) => {
    if (new Set(registry.devices.map((device) => device.id)).size !== registry.devices.length)
      context.addIssue({ code: "custom", message: "Duplicate remote device id" });
  });
const base = {
  operationId: text,
  deviceId: text,
  expectedRevision: z.number().int().nonnegative().nullable(),
};
export const remoteDeviceMutationRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("save"),
    name: z.string().trim().min(1).max(200),
    target: remoteDeviceTargetSchema,
  }),
  z.strictObject({ ...base, type: z.literal("remove") }),
]);
export type RemoteDeviceMutationRequest = z.infer<typeof remoteDeviceMutationRequestSchema>;
export const remoteDeviceMutationResultSchema = z.strictObject({
  status: z.enum(["applied", "conflict"]),
  device: remoteDeviceDefinitionSchema.nullable(),
  reason: z.string().optional(),
});
export type RemoteDeviceMutationResult = z.infer<typeof remoteDeviceMutationResultSchema>;
export const remoteDeviceMutationReceiptsSchema = z
  .array(
    z.strictObject({
      operationId: text,
      request: z.string(),
      result: remoteDeviceMutationResultSchema,
    }),
  )
  .max(256);
