const CURSOR_AUXILIARY = new Set([
  "/aiserver.v1.ServerConfigService/GetServerConfig",
  "/aiserver.v1.DashboardService/GetFilteredUsageEvents",
  "/aiserver.v1.DashboardService/GetMe",
  "/aiserver.v1.DashboardService/GetPlanInfo",
  "/aiserver.v1.DashboardService/GetHardLimit",
  "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
  "/aiserver.v1.AiService/AvailableModels",
  "/agent.v1.AgentService/GetUsableModels",
]);
/** 仅放行已核对的辅助接口；不能按整个域名或路径前缀豁免推理 POST。 */
export function isPluginAuxiliaryRequest(
  channel: string,
  input: string | URL | Request,
  init: RequestInit = {},
): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (channel === "kiro") {
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // API Key 首次发现也发生在推理 operation；仅控制面 root/target 豁免，运行时 POST 仍限一次。
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["management.us-east-1.kiro.dev", "management.eu-central-1.kiro.dev"].includes(
        url.hostname,
      ) &&
      url.pathname === "/" &&
      (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() === "POST" &&
      headers.get("tokentype") === "API_KEY" &&
      [
        "AmazonCodeWhispererService.GetProfile",
        "KiroControlPlaneBearerService.ListAvailableModels",
        "AmazonCodeWhispererService.GetUsageLimits",
      ].includes(headers.get("x-amz-target") ?? "")
    );
  }
  return (
    (channel === "cursor" &&
      url.hostname === "api2.cursor.sh" &&
      CURSOR_AUXILIARY.has(url.pathname)) ||
    (channel === "zed" && url.hostname === "cloud.zed.dev" && url.pathname === "/client/llm_tokens")
  );
}
