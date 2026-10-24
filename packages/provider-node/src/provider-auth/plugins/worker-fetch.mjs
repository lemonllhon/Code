import { geminiRequest, codeAssistResponse } from "../native/google-wire.ts";
import { prepareToolSchemas } from "../native/tool-schema.ts";
import { createHash } from "node:crypto";

export async function fetchPluginModel({
  channel,
  hooks,
  provider,
  loader,
  model,
  request: r,
  requestSessionKey,
  requestTurnKey,
  signal,
  singleAttempt,
}) {
  const headers = new Headers(r.headers);
  for (const [key, value] of Object.entries(loader.headers ?? {}))
    if (!headers.has(key)) headers.set(key, value);
  let body = r.body ? new TextDecoder().decode(r.body) : undefined;
  let payload = body ? JSON.parse(body) : {};
  // 内部任务关联只能来自 Host 上下文，不能信任请求 JSON 中同名字段。
  if (channel === "qoder" || channel === "qoder-cn") delete payload.__lcode_task_key;
  const addresses = [loader.baseURL, provider.api, model?.api?.url, model?.provider?.api].filter(
    Boolean,
  );
  const target = new URL(r.url);
  if (
    r.method !== "POST" ||
    !addresses.some((base) => new URL(base).origin === target.origin) ||
    !/\/(messages(?:\/count_tokens)?|chat\/completions|responses)$/.test(target.pathname)
  )
    throw new Error("Request is outside this provider's model endpoint");
  // Responses 同样要求 object 根；Factory 的 Messages 保留已有包装/解包。
  const messages = /\/messages(?:\/count_tokens)?$/.test(target.pathname);
  const responses = target.pathname.endsWith("/responses");
  if (!(messages && channel === "factory")) {
    payload = prepareToolSchemas(
      payload,
      messages ? "anthropic-messages" : responses ? "openai-responses" : "openai-chat-completions",
      {
        objectRoots: true,
        oneOfAsAnyOf: channel === "cline",
      },
    );
    body = JSON.stringify(payload);
  }
  const sessionID = headers.get("x-lcode-session-id");
  headers.delete("x-lcode-session-id");
  // 使用 Host 原会话事实，不能按首条提示词把不同 workspace/session 合成同一厂商会话。
  if ((channel === "qoder" || channel === "qoder-cn") && requestSessionKey?.trim()) {
    payload.prompt_cache_key = requestSessionKey;
    if (requestTurnKey?.trim())
      payload.__lcode_task_key = createHash("sha256")
        .update(JSON.stringify([requestSessionKey, requestTurnKey]))
        .digest("hex");
    body = JSON.stringify(payload);
  }
  const scopedChannel = ["qoder", "qoder-cn", "trae-cn", "trae-global"].includes(channel);
  const providerSession =
    scopedChannel && requestSessionKey?.trim()
      ? createHash("sha256").update(requestSessionKey).digest("hex")
      : sessionID;
  if (providerSession && hooks["chat.headers"]) {
    const output = { headers: {} };
    await hooks["chat.headers"](
      {
        sessionID: providerSession,
        model: { ...model, id: payload.model, providerID: provider.id },
        provider: { info: provider, source: "custom", options: loader },
      },
      output,
    );
    for (const [key, value] of Object.entries(output.headers)) headers.set(key, value);
  }
  const google =
    channel === "zed" &&
    ((model?.api?.npm ?? model?.provider?.npm ?? provider.npm)?.includes("google") ||
      String(payload.model).startsWith("gemini"));
  if (google) {
    body = JSON.stringify(geminiRequest(payload));
    target.pathname =
      new URL(loader.baseURL).pathname.replace(/\/$/, "") +
      "/models/" +
      encodeURIComponent(payload.model) +
      ":streamGenerateContent";
    target.search = "?alt=sse";
  }
  signal.throwIfAborted();
  const request = new Request(target, { method: r.method, headers, body, signal });
  let response;
  try {
    response = await loader.fetch(request, {
      method: r.method,
      headers,
      body,
      signal,
      routingSingleAttempt: !!singleAttempt,
    });
  } catch (error) {
    if (!singleAttempt?.violated) throw error;
    response = singleAttempt.failure();
  }
  if (singleAttempt?.violated) {
    await response.body?.cancel();
    response = singleAttempt.failure();
  }
  response = singleAttempt?.preserve(response) ?? response;
  return {
    response: google
      ? codeAssistResponse(response, payload.model, payload.stream === true, signal)
      : response,
    signIn: response.headers.get("x-magpie-sign-in"),
  };
}
