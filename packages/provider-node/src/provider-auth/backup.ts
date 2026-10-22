import type { AuthGrant } from "./driver.js";
const PORTABLE_CHANNELS = new Set([
  "codex",
  "chatgpt-api",
  "copilot",
  "gemini",
  "antigravity",
  "claude",
]);
const COMMON = [
  "type",
  "access",
  "refresh",
  "expires",
  "key",
  "accountId",
  "email",
  "displayName",
  "identityKey",
  "plan",
];
const CHANNEL_FIELDS: Record<string, string[]> = {
  codex: ["clientId", "modelInstructions"],
  "chatgpt-api": ["clientId"],
  copilot: ["apiBase", "copilotMode", "host", "sessionToken", "sessionExpires"],
  gemini: ["projectId", "projectReady", "paidTier", "tier"],
  antigravity: ["projectId", "projectReady", "paidTier", "tier"],
  claude: ["claudeCredentials"],
};
/** 本地路径与设备身份不能作为可移植授权；未声明渠道只恢复账号信息并要求重新授权。 */
export function exportPortableProviderGrant(channelId: string, grant: AuthGrant) {
  const portable = PORTABLE_CHANNELS.has(channelId);
  const fields = portable ? [...COMMON, ...(CHANNEL_FIELDS[channelId] ?? [])] : ["type"];
  return {
    grant: Object.fromEntries(
      fields
        .filter((key) => grant[key] !== undefined)
        .map((key) => [key, structuredClone(grant[key])]),
    ) as AuthGrant,
    requiresAuthorization: !portable,
  };
}
