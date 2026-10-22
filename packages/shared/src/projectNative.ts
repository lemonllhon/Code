import { z } from "zod";

export const PROJECT_NATIVE_METHOD = "project/native";
export const PROJECT_NATIVE_ROUTE_METHOD = "project/routeNative";
export const projectNativeOperationSchema = z.strictObject({
  port: z.enum(["filesystem", "execution", "gitAccount", "gitContext"]),
  method: z.enum([
    "createDirectory",
    "stat",
    "readTextFile",
    "readBinaryFile",
    "readTextFileRange",
    "writeTextFile",
    "removeFile",
    "listDirectory",
    "searchFiles",
    "searchText",
    "run",
    "runBashWithBackgroundLifecycle",
    "start",
    "getBackgroundTask",
    "waitForBackgroundTask",
    "readBackgroundBashOutput",
    "cancelBackgroundTask",
    "close",
    "cancelCall",
    "resolve",
  ]),
  args: z.array(z.json()).max(3),
});
export const projectNativeRequestSchema = z.strictObject({
  ownerId: z.string().min(1).max(200),
  callId: z.string().min(1).max(200),
  routeToken: z.string().min(1).max(65536),
  operation: projectNativeOperationSchema,
});
export const projectNativeResultSchema = z.json();
export type ProjectNativeOperation = z.infer<typeof projectNativeOperationSchema>;
export type ProjectNativeRequest = z.infer<typeof projectNativeRequestSchema>;
export type ProjectNativeResult = z.infer<typeof projectNativeResultSchema>;

/** JSON RPC 保留原生端口的 Date、二进制和 undefined；不能把文件内容或退出码当作展示文本转发。 */
export function encodeProjectNativeValue(value: unknown): ProjectNativeResult {
  if (value === undefined) return { $native: "undefined" };
  if (value instanceof Date) return { $native: "date", value: value.toISOString() };
  if (value instanceof Uint8Array) {
    let binary = "";
    for (let offset = 0; offset < value.length; offset += 8192)
      binary += String.fromCharCode(...value.subarray(offset, offset + 8192));
    return { $native: "bytes", value: btoa(binary) };
  }
  if (Array.isArray(value)) return value.map(encodeProjectNativeValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeProjectNativeValue(child)]),
    );
  return projectNativeResultSchema.parse(value);
}
export function decodeProjectNativeValue(value: ProjectNativeResult): unknown {
  if (Array.isArray(value)) return value.map(decodeProjectNativeValue);
  if (value && typeof value === "object") {
    if (value.$native === "undefined") return undefined;
    if (value.$native === "date" && typeof value.value === "string") return new Date(value.value);
    if (value.$native === "bytes" && typeof value.value === "string")
      return Uint8Array.from(atob(value.value), (character) => character.charCodeAt(0));
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeProjectNativeValue(child)]),
    );
  }
  return value;
}
