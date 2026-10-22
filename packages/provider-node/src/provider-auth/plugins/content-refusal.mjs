import { normalizeContentRefusalResponse } from "../../content-refusal.ts";

/** 所有固定插件复用公共分类；Factory 的来源特例同样由公共函数处理。 */
export function normalizePluginContentRefusal(channel, response) {
  return normalizeContentRefusalResponse(response, channel);
}
