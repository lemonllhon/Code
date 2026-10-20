# 固定供应商插件的六项兼容修复

## 范围与产品规则

在当前 HEAD（包含 `e0f86749` 与 `210cc217`）基础上，移植 plugins `5b68df0057501d67b3eda711800ad57254634a58` 中已经确认的六项修复。固定 vendor `5d5d86e` 的原始字节、版本及 SHA 保持原样，构建 worker 时对已校验源码做精确、失败即阻断的内存补丁；新适配的来源单独登记。没有相邻参考仓库的运行时依赖。

1. Qoder：仅解包外层无业务 code / 401 / 403 中明确的 `10605` 忙碌正文，返回 503 和厂商重试间隔，不标记登录过期。真实认证、额度及请求错误保留；流内 BOM/空白不丢文本。目录获取失败区分鉴权失败与 502，未知模型仍为 400。
2. Zen Free：流式 function.name / arguments 的 null 或缺省表示没有新增字节；保留既有分片、工具名和参数。其他非法类型仍失败。保持当前未知工具处理规则，不引入无关的工具策略变化。
3. Factory：仅其 OpenAI Responses 模型移除不支持的 temperature / top_p，即使已带 Droid 前缀也生效；其他模型与 Chat 路径不扩展本轮范围。
4. Zed：有套餐且启用 hosted models 的组织优先；先保留仍可用的已选组织，其次默认、个人及其他有套餐组织；全部无套餐时保留原选择。组织套餐不回填成账号全局套餐。现有连接在目录重新读取及额度刷新时可重选，组织变更经原 Host 凭据 CAS 提交后才读取该组织模型，token / 目录按组织隔离。模型请求失败保留原响应，不在插件内自动重发推理 POST；用户刷新目录后的下一请求使用新组织。
5. Devin：工具结果自身的内联图片及带精确来源标记、数量的后续图片归回对应 tool_call_id；普通用户图片和文字保持用户消息，未知/重复工具结果不冒充已声明结果。只改变发出的请求投影，不修改 transcript、原始消息、工具执行或媒体存储。
6. WorkBuddy AI：支持 `x0.34 credits` 等明确积分后缀；无效/未知不补零，免费与促销规则仍从原目录事实派生。

## 所有者、接口与顺序

不新增服务或公共协议。Host ProviderAccounts 继续拥有账号、凭据与代次；worker 仅执行当前 operation；Runner / 原账号路由拥有物理推理准入和重试。Zed 目录重选仍用现有 client.auth.set → 原凭据通道，不增加账号状态副本。

```text
UI / CLI → Host ProviderAccounts（锁、代次、CAS）→ 固定 worker operation → 上游
目录重读 → 当前账号 me → 选组织 → await 原凭据 CAS → 该组织 token / 模型目录
模型 POST → 厂商结果 → 有限协议归一化 → 原 Runner 判断；插件不增加推理重试
SDK → 原 Runtime / ToolExecutor → SessionStore 批量事务 → 原 ProductProjection
                                                    ├→ desktop-continuous
                                                    └→ web-remote-replayable
完成轮 → 原分页证据 → 分段生成/独立核验 → 原租约/CAS → 全部完成才推进 cursor
```

当前单次派发的首个物理失败保护需要保留；仅 Qoder 固定驱动明确给出带 Retry-After 的 503 busy 时保留其归一化结果，违规重派发及其他渠道继续恢复首个物理响应。不能借此开放第二次 POST，也不能丢弃 Cursor 的原始状态/Retry-After。

## 必须保持的成果

- `@ai-sdk/openai-compatible` 空 tool_calls 补丁、真实块/签名与完整历史。
- parts 批量事务、工具共享并发许可、写屏障、声明顺序、权限与取消。
- 原始记忆与证据无固定业务总量上限、分页核验、断点恢复、来源重验、租约与 CAS。
- workspace identity、远程 session、owner/lease、stale run 与双 delivery 边界。
- 原 Qoder/Trae 缓存计数补丁、轮换刷新、既有签到规则、worker 关闭与安全诊断。
- 本轮不接入 Cursor 新 Run 状态机、HTTP/2 PING、新渠道及其他上游策略。

## 验收

先以六组合成输入补充可失败的回归，再验证正式生成 worker 与 loopback fixture。覆盖 WorkBuddy 未知/零/小数、Factory 保留参数边界、Qoder 真实错误与包装 busy/目录/重试、Zen Free 多分片/null/非法类型/取消、Devin 多工具图片/用户图片/孤立或缺失标记/输入不变、Zed 多组织/无套餐/禁用/已有组织/持久化失败/取消/跨账号与原单次派发。

执行现有供应商原生与插件、缓存、刷新、生命周期、路由与远端回归；运行 `node scripts/test-model-stream-tool-pipeline.mjs --browser` 和 `node scripts/verify-agent-memory-and-composer-predictions.mjs` 保留引用会话成果，并复测现有本地性能基准。根目录 typecheck、lint 与 changed 架构检查、发行输入/worker/许可一致性必须通过；如存在已有失败或环境限制分别记录。所有 fixture 使用合成凭据，不读取真实账号或发起厂商调用。

## 实施与验证记录

性能复测使用 `node --import tsx scripts/benchmark-memory-evidence.mts .artifacts/provider-backports-20261020/memory-performance`，输出参数仅用于把新证据写入独立目录，保留此前验证材料。工具调度复用 `scripts/bench-tool-scheduling.mjs` 的输出参数。

六项修复已落地。工作区原有 UI/队列等修改保留；`e0f86749`、`210cc217` 均为当前 HEAD 祖先。原记忆、SessionStore、Runtime 和 SDK patches 的实现相对 HEAD 无差异。原 15 包 / 21 个 vendor 文件的 SHA 全部匹配，仍固定于 `5d5d86e`；新回移来源独立登记为 `5b68df0`。worker 已重新生成并逐字节验证新鲜度，大小 2,105,428 bytes；原缓存、签到和轮换补丁继续进入同一构建。

Windows、Node 24.21.0 下实际执行（各组有重叠，不相加作唯一测试总量）：

| 验证                                                            | 结果                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| provider-auth 全目录，原生/插件/缓存/刷新/关闭与新回移          | 356 通过，0 失败、0 跳过                                                                  |
| `pnpm test:provider-routing`                                    | 提交前完整复跑 517 通过，0 失败、0 跳过，含两项新增纯协议边界测试                         |
| `node scripts/test-model-stream-tool-pipeline.mjs --browser`    | 164 通过，覆盖 SDK、批量持久化、并发/屏障、取消及桌面/手机投影                            |
| `node scripts/verify-agent-memory-and-composer-predictions.mjs` | 407 Agent/存储/Runtime + 20 UI/协议 + 18 浏览器用例通过                                   |
| `node scripts/test-session-permission-mode-switch.mjs`          | 47 + 1 通过                                                                               |
| `pnpm test:remote-providers`                                    | 15 通过，含上游状态、响应头和正文的 relay 保真                                            |
| `pnpm test:release`                                             | 137 通过、1 Chromium page-helper 环境跳过、0 失败                                         |
| 根 `pnpm typecheck` / `pnpm lint`                               | 通过；新增测试严格校验 `Request.json()` 的 unknown 类型                                   |
| `pnpm architecture:check --changed`                             | violations 0，baseline 0，new 0；provider-node 仍为 unmanaged，不把零违规称为全部边界覆盖 |
| 定向 oxfmt / `git diff --check`                                 | 通过，无无关文件格式化                                                                    |
| worker 重生成对照 / notices / release inputs                    | 通过；提交前 Git index 3,011 输入校验，沿用原有 20 项材料缺口策略                         |

实际 loopback worker 验证了 Qoder 两区域及 HTTP/流内 busy → 503、Retry-After、零凭据写入及单次物理派发；Factory Responses 采样字段移除；Zen Free 完整工具参数；Devin protobuf 中截图归属；WorkBuddy 两区域倍率及促销；Zed CAS 前不 mint、写入失败和取消不继续、402 不重放推理。合成协议测试另外覆盖多工具图片、缺图说明、孤立/重复结果与普通用户图片不串位，以及 null 分片后的取消传递。

新增的 Qoder 正常归一化最初放宽过所有渠道；完整回归发现 Cursor H2 原状态/Retry-After 被改变，已收窄到明确的 Qoder busy，Cursor 两项及完整供应商回归重新通过。第一次扩大路由组合的十万 Key 性能断言在同时跑记忆大文件/浏览器时超限；未修改生产实现或阈值，隔离实测 hot P95 13.89 ms，最后完整路由也通过。

## 性能复测与限制

30 次采样、预热 3 次、每轮写入使证明缓存失效；完整读取与分页证据覆盖均为 true。第一次与其它重 IO 验证并行的记录保留在 `memory-performance/`；以下低负载复测另存 `memory-performance-isolated/`，不覆盖原会话的历史报告。

| 合成场景       | 完整读取 P95 | 分页读取 P95 |
| -------------- | ------------ | ------------ |
| 2,256 parts    | 20.75 ms     | 15.33 ms     |
| 10,000 parts   | 71.16 ms     | 37.07 ms     |
| 累计 50 工具   | 19.94 ms     | 13.34 ms     |
| 300 消息长轮次 | 27.42 ms     | 22.12 ms     |

10,000 parts 的返回量从 11,937,422 bytes 降至 40,891 bytes，原始完整证据仍被覆盖。工具基准继续使用同一个真实 Scheduler/Executor、并发 2 和 `[60,5,5,60]ms` 受控 handler；补位路径 P95 95.01 ms。以上仅为本地合成读写/调度时间，不包括模型和网络，不能与不同负载下的旧绝对值直接比较或宣称真实供应商提速。

日志及性能 JSON 位于 `.artifacts/provider-backports-20261020/`。本轮没有真实厂商账号调用、安装版替换或 macOS/Linux 真机验证；未引入 Cursor 新状态机、HTTP/2 PING 或新渠道。

索引增加了现有 OAuth 节点的别名和 backport 源码种子，106 个 ID 唯一、156 条关系端点/等级以及本节点的 12 个路径/符号已校验。现有 `docs/skills/feature-boundary-graph.md` 引用缺失记为 graph-drift-candidate，不恢复历史文档。

变更量：17 个源/测试/文档文件，新增 1,255 / 删除 76，净增 1,179 行（不含生成 worker 与三方材料元数据）。

扩大路由回归发现一个既有 fixture 不一致：`providerAccountSdk.test.ts` 根据最终 generate/stream 接口选择 JSON/SSE，而当前 Runner 的 generate 也经 SSE 收集；隔离运行同样复现三协议失败。本轮只让 fixture 按实际 request.stream 响应并断言它为 true，保留 Runner 生产实现及原调用次数、Token reservation/settlement 断言。
