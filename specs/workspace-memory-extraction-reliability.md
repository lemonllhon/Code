# 自动工作区记忆提取的预算与回退窗口修复

## 2026-10-20：完成响应的预算判断与发布流程学习

只读历史证据确认两次自动提取均已取得 `stop` 响应，正文分别为 4712、3699 字符，随后在 generation 阶段报 `budget_exceeded`，没有核验或提交。两次正文均低于 80000 字符限制；请求已经完成，排除请求预检。辅助响应按既有 `skipTranscript` 不落盘，用量日志已脱敏，因此无法恢复当时是 output usage 还是 item count 分支，不能将推测写成历史定论。

源码可复现的缺陷：生成系统提示同时给出全量 10 项与增量 3 项；已完整返回且结构合法的候选，会因为供应商 usage 高于请求的输出上限而全部丢弃。usage 是事后计量（可能包含推理），不能代替响应完整性和内容预算判据。失败统一报码也使二者不可区分。

规则与所有者：

- 继续由原 Runtime 成功轮 scheduler 触发、SessionStore 提供固定完成边界证据、learning/root lock 管理消费与租约、ProjectMemory 负责核验后的 CAS/journal 提交，不增加状态库、UI 队列或供应商特判。
- 请求仍带原有有界 maxOutputTokens，受模型能力和 context 预检约束。`length`、工具调用、非法 JSON、响应字符超限、候选超限仍拒绝；完整 `stop` 响应仅 usage 超过请求值时记录脱敏告警，继续独立核验，绝不因此跳过核验或增加模型重试。
- 生成提示只使用当前 profile 的一个候选上限。候选超过上限仍整批失败，不静默截掉尾项或消费未审内容。
- 自动候选明确包含用户已采用的项目发布/部署流程、约束、纠正和可复用排障经验，不要求出现“记住”。优先更新已读取的相关记忆，保留原有有用内容，省略单次版本号/构建状态；来源只是背景材料，不赋予执行发布或修改权限的授权。
- 请求字符、请求 token、context、响应字符和候选数量超限分别提供稳定 reason、实际值和限制值；usage 告警包含阶段和数字。继续不记录正文、文件名、路径、凭据或原始异常，不启用辅助 model-io 落盘。
- 不自动追补历史计费请求，不改远程 workspace 禁用规则。Desktop continuous 和手机 replayable 沿用同一 Runtime/Host owner 与事件顺序。

```mermaid
sequenceDiagram
  participant R as Runtime scheduler
  participant S as SessionStore
  participant M as Model
  participant P as ProjectMemory / learning lock
  R->>S: 固定成功轮边界，读取并冻结证据
  R->>P: claim 同一证据键
  R->>M: 生成（唯一候选上限，原输出预算）
  M-->>R: stop / JSON / usage
  R->>R: 校验正文；usage 偏差仅脱敏告警
  R->>S: 重验同一来源
  R->>M: 独立核验（同样校验完整性）
  R->>P: 原 CAS + journal；成功后 finish 消费
```

验收先补回归：生成与核验 usage 超额但完整合法时可保存；截断、过多候选、非法来源、核验拒绝、CAS 冲突仍不可写。真实 Runtime + 临时 SQLite + 文件 adapter 中，普通发布请求（没有记忆指令）能自动更新已有发布流程、保留旧约束，重复恢复不重复模型请求；模型为可控夹具，不以此宣称真实模型质量已验证。对预算分支及日志脱敏分别断言，执行根与 CLI typecheck/lint、记忆回归和架构门禁。

### 本次验证

- 新增完成响应回归先在旧实现执行，4 项失败；修复后通过。真实 Runtime/SQLite/CAS 发布流程测试验证自动更新、独立核验拒绝保留原文、消费去重及两阶段数字告警。既有核验安全用例由“仅 usage 超额即拒绝”改为“截断即拒绝”，完整响应超额场景由新增回归验证。
- `node scripts/verify-agent-memory-and-composer-predictions.mjs` 最终全部通过：414 项 Agent/SQLite/Runtime/CAS、20 项 UI/协议、18 项桌面键盘/IME/恢复与手机视口浏览器回归，共 452 项，零失败、零跳过。
- 根 `pnpm typecheck`、`pnpm lint` 通过；CLI typecheck 27 个任务成功（19 个缓存），lint 14 个任务成功（12 个缓存）。Turbo 保留既有 workspace 不在 lockfile 的警告；旧 Node 版本警告来自缓存日志，当前 shell 与根/CLI `pnpm exec node --version` 均为 24.21.0。
- 变更属于既有 `lcode-cli` 模块；`pnpm architecture:check --changed` 为 0 violations / 0 baseline / 0 new。所有修改文件格式及 `git diff --check` 通过。
- 只使用合成项目和可控模型；没有付费重放历史、改写个人记忆或替换安装版。历史两次失败的具体预算分支仍因缺少原始辅助响应而不可恢复；新增诊断防止未来继续出现同样的不可区分状态。修复需随新构建启动后生效，未声称已在真实供应商、macOS/Linux 或手机实机验证生成质量。

## 2026-10-11：原始修复

日期：2026-10-11。用户已要求修复调查发现的自动保存阻塞。本规格补充首版实施契约，不修改个人记忆、不触发历史会话付费补提取、不替换安装包。

## 已确认的问题

- SessionStore 的 `maxDataBytes` 定义为 admitted message/part 原始 JSON 数据列的 UTF-8 字节。Core 却把注入消息/part ID、sessionID、messageID 和容器后的 JSON 按同一上限再次检查，合法的接近 256 KiB 窗口会在模型请求前误报 `budget_exceeded`。
- 回退之后的长会话，cut 已落到窗口前缀之外时，Core 无法证明当前窗口位于新分支，因而一直跳过。不能通过直接忽略缺失 cut 来解决，否则会重新学习废弃分支。
- 旧自动输出上限为生成1536/核验768，已观察到 `length` 且正文为空。不能据此断言推理映射错误，但总输出预算需要为推理和结构化正文留出更合理的有界空间，失败原因也需要可查询的脱敏诊断。

## 所有者、接口和规则

1. SQLite SessionStore 继续独占持久会话、顺序与回退事实；Runtime 继续拥有轮后scheduler、cursor和取消。Markdown仍为唯一记忆事实源，所有保存仍走既有独立核验与CAS。
2. Core 按端口原始数据字节预算校验 `loadedDataBytes`，并检查消息/part行数及计数一致性。对解码材料另行累计去掉由行列注入的ID字段后的JSON payload字节，作为原始字节下界，拒绝超额payload或虚报计数；不把容器/行ID开销再次算进原始预算。输入模型的编码请求预算仍独立检查，不能因读取合格放开模型预算。
3. `SessionTranscriptWindow.branchCutBeforeWindow?` 是可选证明 `{ messageID, branchGeneration? }`。仅SQLite在同一读取savepoint内证明当前session的cut行按同一sequence/null/time/rowid顺序严格早于最早完整入窗消息时提供；只读取锚点顺序列，不读额外正文。scope与generation来自同一window.session。无cut、cut被删、属于其他session、cut在窗口内或之后均不提供证明；空/不完整窗口也不提供。
4. Core 只接受prefixTruncated、匹配当前cut ID与branchGeneration的证明，才允许消费完整窗口后缀。否则沿原缺失边界保护规则跳过。窗口内cut仍只取cut之后；compact派生摘要、synthetic通知、没有完整真实用户边界的窗口仍不可成为证据。scheduler准入与生成/核验/commit前重读共用同一分支规则。
5. 旧adapter不提供该字段时仍保持fail-closed。没有DB schema迁移、没有第二份分支状态或全量历史读取兜底；证明不写入session、不使用超时猜测。源码端口扩展不修改Desktop/手机stream协议。
6. 自动模式保留1轮/6000字符、2记忆/4000字符、3候选、6000估算输入tokens/20000编码字符。生成与核验总输出上限改为4096/2048，仍按模型公开能力截小且预检context预算，不增加请求次数或应用重试。`length`返回结构化`output_truncated`错误及generation/verification阶段，绝不能把截断或空正文当候选。
7. Runtime记录一次轮后结果（applied/rejected/conflicts/skippedReason）或失败（稳定code/phase），不记录正文、候选、路径、provider原始错误或凭据。快照准入失败也有脱敏诊断。关闭、取消、远程workspace和已有受控提交边界保持原规则。

```mermaid
sequenceDiagram
  participant R as Runtime / scheduler owner
  participant S as SQLite SessionStore owner
  participant C as Core review
  participant M as Model port
  participant F as ProjectMemory CAS owner
  R->>S: completed boundary + bounded window
  S->>S: 同一savepoint读取metadata/完整后缀/可选cut顺序证明
  S-->>R: 原始字节计数 + 同scope证明
  R->>C: 完成轮快照（单runtime串行）
  C->>S: 重读固定边界与当前分支
  C->>C: 同口径预算 + 分支证明 + 真实用户边界
  C->>M: 有界生成（最多一次）
  C->>S: 重新验证来源与分支
  C->>M: 独立核验（最多一次）
  C->>S: commit前来源/branch generation核对
  C->>F: 原有版本检查写入
  C-->>R: 结果或稳定错误，脱敏日志/cursor按既有规则推进
```

Desktop continuous与手机replayable仍消费同一Host/Runtime。远程workspace的自动提取仍按现有禁用边界处理，本改动不增加Host、Agent、queue或snapshot业务所有者。

## 验收

- 合成临时SQLite历史，原始payload小于等于256 KiB、解码JSON超过上限，真实Runtime完成轮后能经过生成、独立核验并受控保存；虚报loadedDataBytes、超额payload/行数/错误scope仍拒绝。
- cut在窗口前、内、后、缺失、其他session、NULL sequence与相同时间/rowid顺序均验证；只接收同scope同generation证明。旧adapter无证明保持跳过，branch在核验前变化拒绝应用。
- 长会话cold resume且cut落到窗口外，完整当前用户轮仍能自动保存，旧废弃分支和未来消息不进入模型；不读取全量messages。
- 最多两次无工具辅助请求，最低公开推理档、模型最大值/context限制、length/空正文、核验拒绝、取消和CAS冲突均验证；无额外重试或未审写入。
- 使用fake model和临时记忆，执行相关node:test、根及CLI typecheck/lint、架构和改动文件格式检查。真实用户会话只读核对证据准入，不调用真实模型或实际保存。

## 验证记录

- Node 24.21.0、pnpm 10.34.6；核心记忆/召回/scheduler/完成轮/权限回归202/202通过，真实SQLite snapshot/window/预算/跨连接竞态16/16通过。
- 新增两项真实Runtime冷恢复、SQLite有界窗口、独立fake model核验、真实ProjectMemory CAS落盘测试通过，分别覆盖原始字节合格但解码JSON超额、回退cut落到窗口外。原位置/Bash cwd/cold resume三项回归通过。
- 真实用户会话仅只读重放九个已完成窗口：九个均可取得有界有效证据，零模型调用、零写入。测试不能证明真实模型已生成候选或个人记忆已新增。
- 根typecheck/lint、CLI typecheck（27任务）/lint（14任务）通过。Turbo仍提示已有lockfile工作区闭包缺失，命令退出码为0；不改无关lockfile。
- 变更模块为`lcode-cli`，既有SessionStore/Runtime/ProjectMemory所有者不变；架构检查0 violations / baseline 0 / new 0。19个改动TypeScript文件与3个规格文件格式检查通过；22文件增加915行、删除31行，净增加884行（主要为回归测试与规格）。
- 安装程序未替换；尚未验证真实付费模型、其他操作系统或手机实机。只在已有自动提取边界内修复，不对历史轮自动执行付费补提取。
