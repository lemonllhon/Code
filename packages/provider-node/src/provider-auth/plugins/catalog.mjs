import { ClinePlugin } from "../vendor/cline/index.mjs.source";
import { CommandCodePlugin } from "../vendor/commandcode/index.mjs.source";
import { CursorAuthPlugin } from "../vendor/cursor/index.mjs.source";
import { DevinAuthPlugin } from "../vendor/devin/index.mjs.source";
import { FactoryAuthPlugin } from "../vendor/factory/index.mjs.source";
import { GrokAuthPlugin } from "../vendor/grok/index.mjs.source";
import { KiroAuthPlugin } from "../vendor/kiro/index.mjs.source";
import {
  MiniMaxCodeAuthPlugin,
  MiniMaxCodeGlobalAuthPlugin,
} from "../vendor/minimax/index.mjs.source";
import { MimoAuthPlugin } from "../vendor/mimo/index.mjs.source";
import { QoderAuthPlugin, QoderCNAuthPlugin } from "../vendor/qoder/index.mjs.source";
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin } from "../vendor/trae/index.mjs.source";
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin } from "../vendor/workbuddy/index.mjs.source";
import { ZCodeAuthPlugin, _internal as zcodeInternal } from "../vendor/zcode/index.mjs.source";
import { ZedAuthPlugin } from "../vendor/zed/index.mjs.source";
import { ZenFreePlugin } from "../vendor/zen-free/index.mjs.source";

async function zcodePlugin(options) {
  const hooks = await ZCodeAuthPlugin(options);
  // 修复：0.1.24 插入团队入口后本机/API 编号后移；保留旧编号，避免本机检测误走团队登录。
  const [team] = hooks.auth.methods.splice(2, 1);
  hooks.auth.methods.push(team);
  return hooks;
}

export const plugins = {
  cline: ClinePlugin,
  "commandcode-plan": CommandCodePlugin,
  cursor: CursorAuthPlugin,
  devin: DevinAuthPlugin,
  factory: FactoryAuthPlugin,
  grok: GrokAuthPlugin,
  kiro: KiroAuthPlugin,
  "minimax-code": MiniMaxCodeAuthPlugin,
  "minimax-code-global": MiniMaxCodeGlobalAuthPlugin,
  "mimo-app": MimoAuthPlugin,
  qoder: QoderAuthPlugin,
  "qoder-cn": QoderCNAuthPlugin,
  "trae-cn": TraeCNAuthPlugin,
  "trae-global": TraeGlobalAuthPlugin,
  workbuddy: WorkBuddyAuthPlugin,
  "workbuddy-ai": WorkBuddyAIAuthPlugin,
  bigmodel: zcodePlugin,
  zai: zcodePlugin,
  zed: ZedAuthPlugin,
  "opencode-zen-free": ZenFreePlugin,
};

export function assertGrantChannel(channel, grant) {
  if (channel !== "zai" && channel !== "bigmodel") return;
  const state = grant?.type === "oauth" ? JSON.parse(grant.refresh || "{}") : grant?.metadata;
  const current = state?.source === "zcode" ? zcodeInternal.ownSignIn() : state;
  if (current?.site && current.site !== channel) {
    throw new Error(
      `The imported ZCode account belongs to ${current.site}; use its matching channel`,
    );
  }
}
