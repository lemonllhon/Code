import type { ILCodeAgentService } from "@lcode/services";
import {
  PROJECT_NATIVE_INDEPENDENT_SCHEDULING_MARKER,
  PROJECT_NATIVE_METHOD,
  PROJECT_NATIVE_ROUTE_METHOD,
} from "@lcode/shared";
import type { IRemoteBackend } from "./backend.js";
import { waitForClose } from "./deployShared.js";
import { quotePosixPathArg, quotePosixShellArg } from "./posixShell.js";

export const PROJECT_NATIVE_SERVER_MARKERS = [
  "executeProjectNative",
  "onDynamicProjectNativeRequest",
  "respondProjectNative",
] as const satisfies readonly (keyof ILCodeAgentService)[];
// 中文依据：旧制品包含方法名但原生请求仍被 admission 挡住，同 SHA 也必须校验调度能力。
export const PROJECT_NATIVE_AGENT_MARKERS = [
  PROJECT_NATIVE_METHOD,
  PROJECT_NATIVE_ROUTE_METHOD,
  PROJECT_NATIVE_INDEPENDENT_SCHEDULING_MARKER,
];

export async function checkRemoteBundleCapabilities(
  backend: IRemoteBackend,
  nodePath: string,
  bundlePath: string,
  markers: readonly string[],
): Promise<{ shouldDeploy: false } | { shouldDeploy: true; reason: string }> {
  const script = `
const content = require("fs").readFileSync(process.argv[1], "utf8");
const missing = ${JSON.stringify(markers)}.filter((marker) => !content.includes(marker));
if (missing.length) {
  console.error("missing required runtime capabilities: " + missing.join(","));
  process.exit(2);
}
`;
  try {
    const stream = await backend.exec(
      `${quotePosixPathArg(nodePath)} -e ${quotePosixShellArg(script)} ${quotePosixPathArg(bundlePath)}`,
    );
    await waitForClose(stream);
    return { shouldDeploy: false };
  } catch (error) {
    return { shouldDeploy: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function assertRemoteBundleCapabilities(
  backend: IRemoteBackend,
  nodePath: string,
  bundlePath: string,
  markers: readonly string[],
): Promise<void> {
  const decision = await checkRemoteBundleCapabilities(backend, nodePath, bundlePath, markers);
  // 同版本 CDN/内置制品也可能落后于桌面接口；不能写成功 marker 后才让用户在发送阶段发现缺方法。
  if (decision.shouldDeploy)
    throw new Error(
      `Remote runtime resources are incompatible: ${decision.reason}. Rebuild and publish the matching server and Agent resources, or use a build with current bundled remote assets.`,
    );
}
