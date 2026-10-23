# Knip 剩余告警逐项核对

## 规则与边界

- 承接 [首轮清理](knip-cleanup.md)，以本轮实际报告中的 54 个文件以及导出、类型、重复导出和依赖告警为清单，逐项记录删除证据或保留原因。
- 静态零引用仅作为线索。核对 package scripts、动态 worker/子进程路径、构建及发布装配、类型解析、架构契约、手动开发工具和对应测试，不删除有实际用途的入口。
- 只有确认没有消费者和独立用途的实现才删除；公开契约、推导返回类型、平台装配和可复现的手动工具保留，并注明具体调用位置或运行命令。
- Knip 配置仅表达证实存在的入口和环境依赖，不以整目录入口或通配忽略隐藏未核对项。
- 不改变业务行为、状态 owner、写入路径、事件顺序、桌面连续流和手机可恢复链路；不覆盖其它本地改动。
- BigModel Coding Plan、Z.AI Coding Plan 的模板、Key 保存、模型、网关与 Adapter 作为回归边界；模板配置和官方网关与本轮开工快照核对。

## 验收

- 每个原始文件都有明确处置和证据；其它告警按实际引用及契约用途分类，不能把待确认项写成无用。
- 运行根 typecheck、lint、架构检查；涉及 CLI 时运行 CLI typecheck/lint。
- 验证受影响的构建/入口测试及两个供应商的 Adapter、桌面/手机添加和 Key 保存。
- 记录前后 Knip 数量、真实检查结果与未验证范围。

## 首批核对决策

- `conversation-docker-plan.mjs` 及其两个导出只有自身引用，没有脚本、测试、文档消费者；删除。`armsRumShared.d.ts` 是旁边 `armsRumShared.ts` 的旧生成声明（含 sourceMappingURL），TS 实现仍被 Main/renderer 使用；删除重复产物，保留实现。
- 手动 benchmark/验收、动态 fixture/worker、声明和编译示例按具体文件声明入口，依赖文件通过真实 import 追踪。每个入口的出处在本页最终清单记录，不将整个 scripts 目录视为入口。
- 先校准入口再处理依赖和导出，以免遗漏手动工具的消费者。平台原生包、动态装配依赖与公开接口按实际消费路径核对；只收窄内部声明或删除确实无消费者的依赖。
- 二次依赖核对删除旧 browser-use MCP server 的 8 项残留依赖、没有消费者的重复声明、占位 Swift 的未使用类型依赖等；保留 `@electron/rebuild`，它在 `node-pty-rebuild.mjs` 中按平台拼接二进制名调用。根 `postject` 被 macOS Helper 构建读取；Server 外置模块、PTY 平台包、CSS 构建和忽略的基础组件实际使用的库也保留。
- 构建/维护脚本中只有文件内消费者的导出可收为局部声明，保留声明与初始化。包公开入口、存在外部引用或运行时装配的导出不通过此规则删除。
- 本机全局 Git 忽略会隐藏默认文本搜索中的部分真实测试。引用复核使用不受忽略规则影响的全仓扫描；Knip 的现有测试入口已有效，撤回重复测试入口配置，不修改用户忽略设置。前轮收窄的导出也经全量扫描复核，未发现外部消费者。
- 对静态零引用的声明使用仓库 `dep:refs` 的同一算法批量核对，并补全默认 glob 未覆盖的 CLI 子包源码/测试；另外运行未缩小范围的 `pnpm dep:refs` 查询。23 项旧包装函数、旧分页/偏好写入、旧 Memory 请求构造和未构造的错误类均无引用或再导出，且不在包公开入口中，可删除。保留实际调用的底层实现、当前事件/取消处理、设置导航、备份上传 owner 和记忆 Review 路径；不更改状态或副作用顺序。
- 原独立 `ttft-otlp-receiver.mjs` 不在规范、脚本或测试的消费链上；实际启动证明其旧 protobuf generated/root.js 路径在当前环境已失效。删除这份孤立的旧验收工具，而非把它伪装成有效入口；生产 telemetry、exporter、端点及事件实现均保留。
- Vite 已提供 Desktop main/startup bootstrap JS 入口，移除重复的 JS 入口配置，保留 HTML link 引入的 `startup.css` 精确入口；Web 手动 fixture 的实际 HTML 入口发现保留。移除 3 个 Knip 判定已无必要的 `@lintignore` 标签，保留其具名返回类型导出和声明生成说明。

## 原始 54 个文件的处置

表内保留项通过具体文件表达入口，没有整目录忽略。真实付费模型、SSH/Docker、跨平台发布、素材转码、vendor 同步、用户库重放均不在本轮自动运行。

| 文件                                                                                             | 处置与依据                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/bench-model-stream-tool-pipeline.mjs`                                                   | 模型流/工具流水线的手动基准；docs/benchmarks/model-stream-tool-pipeline-2026-10-19.md 的复现命令。                                  |
| `scripts/bench-tool-scheduling.mjs`                                                              | 工具调度手动基准；同一基准文档及 specs/provider-plugin-backports-2026-10-20.md 引用。                                               |
| `scripts/benchmark-memory-corpus.mts`                                                            | 长文件尾部事实召回基准；specs/workspace-memory-completed-turn-implementation.md 的复现命令。                                        |
| `scripts/benchmark-memory-evidence.mts`                                                          | 记忆证据分页性能基准；同一实现规范及 provider-plugin-backports 复测入口。                                                           |
| `scripts/build-memory-regression.mjs`                                                            | 远端记忆回归构建入口；specs/remote-runtime-memory-regression.md，构建两个 server fixture。                                          |
| `scripts/compile-desktop-agent-bytecode.cjs`                                                     | scripts/build-desktop-agent-bytecode.mjs 按路径 spawn 的 Electron 字节码编译器。                                                    |
| `scripts/desktop-agent-bytecode-runtime.cjs`                                                     | 前项 require，并由 build-desktop-agent-bytecode.mjs 复制；编译和加载共用摘要/版本校验。                                             |
| `scripts/lcode-distribution-smoke.mjs`                                                           | 独立发行 tarball 的 TUI/Web/WS 冒烟入口，文件首部定义 archive 参数和仓库外隔离流程。                                                |
| `scripts/licenses.mjs`                                                                           | 许可/声明维护 CLI；specs/license-material-completion-2026-10-15.md 等提供 check/notices 命令。                                      |
| `scripts/runtime-development-env.d.mts`                                                          | runtime-development-env.mjs 的 TS 类型面；Desktop/Web Vite 导入对应 mjs。                                                           |
| `scripts/sidebar-collaboration-ssh-acceptance.ts`                                                | SSH 侧栏协作验收；specs/sidebar-project-collaboration-acceptance.md 的手动命令。                                                    |
| `scripts/sync-auth-plugin-vendor.mjs`                                                            | 鉴权插件 vendor 的显式维护/钉定命令；specs/http2-concurrency-crash-repair-plan-2026-10-15.md 引用。                                 |
| `scripts/verify-agent-memory-and-composer-predictions.mjs`                                       | Agent/记忆/Composer 综合回归入口；workspace-memory-completed-turn-implementation 等规范引用。                                       |
| `scripts/dev/lcode-stdio-tap.mjs`                                                                | services/lcode-agent/lcodeAgentProcessManager.ts 按路径查找后启动的开发 stdio tap。                                                 |
| `scripts/lcode-distribution/runner.mjs`                                                          | scripts/build-lcode.mjs 复制为发行包 runner，支持 CLI/Web 的实际启动。                                                              |
| `packages/desktop/scripts/agent-memory-provider.fixture.mjs`                                     | 桌面真实链路验收替代外部模型的 loopback fixture；docs/plans/agent-memory-recall-and-composer-predictions.md 记录用途。              |
| `packages/desktop/scripts/benchmark-diff-idle.mjs`                                               | 显示层 A/B 闲时资源基准；specs/renderer-resource-lifecycle.md 指定 baseline SHA 命令。                                              |
| `packages/desktop/scripts/conversation-docker-plan.mjs`                                          | 删除：两个导出仅自身引用，无入口、测试或文档消费者；旧 Docker 验收文档 helper。                                                     |
| `packages/desktop/scripts/desktop-product-identity.d.mts`                                        | desktop-product-identity.mjs 的 TS 公共类型面，供 Main 和构建的 product identity 解析。                                             |
| `packages/desktop/scripts/import-startup-media.mjs`                                              | 启动素材显式导入维护命令；assets/startup-media/README.md、startup animation spec 和 CI 路径引用。                                   |
| `packages/desktop/scripts/powershell-command.d.mts`                                              | powershell-command.mjs 的 TS 声明；主进程等 TS 调用方使用相同 mjs 接口。                                                            |
| `packages/desktop/scripts/startup-media-assets.d.mts`                                            | startup-media-assets.mjs 的 TS 声明；启动素材构建插件消费实际资源接口。                                                             |
| `packages/desktop/scripts/startup-media-transcode.mjs`                                           | import-startup-media.mjs 真实导入的转码/填充图生成模块。                                                                            |
| `packages/desktop/scripts/target-platform.d.mts`                                                 | target-platform.mjs 的 TS 声明；Main/构建的平台与架构解析接口。                                                                     |
| `packages/desktop/scripts/ttft-otlp-receiver.mjs`                                                | 删除：规范/脚本/测试已无消费者，实际启动确认旧 generated/root.js 解码路径不可用；只清理孤立验收工具，生产 telemetry/exporter 保留。 |
| `packages/desktop/scripts/write-dev-ready-marker.mjs`                                            | desktop/tsup.config.ts 的 onSuccess 命令，用独立 main/host/preload/scheduler marker 表示编译完成。                                  |
| `packages/desktop/src/shared/armsRumShared.d.ts`                                                 | 删除：带 sourceMappingURL 的旧生成声明，与现有 armsRumShared.ts 重复；TS 实现和消费者保留。                                         |
| `apps/lcode-cli/packages/bootstrap/scripts/workflow-host-agent.fixture.ts`                       | desktop/scripts/workflow-lifetime-electron.test.mjs 按路径构建并启动的独立 Agent fixture。                                          |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/request-context-quality/provider.ts`       | request-context-quality/run.ts 的真实 provider 配置读取/Adapter 依赖。                                                              |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/request-context-quality/run.ts`            | 请求上下文质量手动基准；specs/request-context-quality-optimization-plan.md 给出复现入口。                                           |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/launch.mjs`            | workflow-efficiency/README.md 指定的基准启动器，加载 register/run。                                                                 |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/provenance.ts`         | workflow-efficiency/run.ts 的来源/版本指纹依赖。                                                                                    |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/provider.ts`           | workflow-efficiency/worker.ts 的正式 Adapter/provider 初始化依赖。                                                                  |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/register.mjs`          | launch.mjs 导入的 tsx 注册入口；只注册现有安装，不下载或构建。                                                                      |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/run.ts`                | launch.mjs 的实际运行实现；fork 单独 worker，输出基准报告。                                                                         |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-efficiency/worker.ts`             | run.ts fork 的隔离执行 worker，复用原 WorkflowEngine。                                                                              |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-stress/measurement-correction.ts` | 保留历史压力证据的显式 --run 修正入口；原始失败样本不覆盖，追加修正原因和测量结果。                                                 |
| `apps/lcode-cli/packages/bootstrap/scripts/benchmarks/workflow-stress/run.ts`                    | 工作流压力手动基准；docs/benchmarks/workflow-efficiency-2026-10-02.md 的复现命令。                                                  |
| `packages/lcode-server-cli/scripts/verify-remote-ssh-target.mjs`                                 | verify-remote-ssh.mjs 导入的 Linux 架构目标校验。                                                                                   |
| `packages/lcode-server-cli/scripts/verify-remote-ssh.mjs`                                        | 有 usage/前置条件的 Docker+SSH 发行验收 CLI；验证现有 staged server 包与隧道生命周期。                                              |
| `apps/lcode-cli/packages/adapters/src/model/api-key-oauth-sdk.fixture.ts`                        | services/model-provider/providerAccountSdk.test.ts 按路径构建/启动的 OAuth SDK fixture。                                            |
| `apps/lcode-cli/packages/core/scripts/export-request-context-quality.ts`                         | 请求上下文质量合成夹具导出 CLI；specs/request-context-quality-optimization-plan.md 引用。                                           |
| `packages/provider-node/src/network.example.ts`                                                  | 公开网络传输契约的可编译示例，展示 fetch/body 与 disposeAndWait 的资源所有权。                                                      |
| `packages/provider/src/rate-limit.example.ts`                                                    | 公开限流契约的可编译示例，展示原 owner 的 extend/wait/dispose 顺序。                                                                |
| `packages/provider/src/routing/contract.example.ts`                                              | architecture:context provider 实际发现的路由契约示例，展示原 lease dispatch/finish/dispose。                                        |
| `apps/lcode-cli/packages/dynamic-workflow/scratch/run.mjs`                                       | 有 usage 的工作流静态分析调试 CLI；消费当前 analyzeWorkflowScript/toActorGraph 和序列化 API。                                       |
| `packages/lcode-cua/cua-driver.d.ts`                                                             | cua-driver.js 的 TS 类型面；驱动 seam 保持包内部，不泄漏 nut-js 类型。                                                              |
| `packages/lcode-cua/installed-app-launcher.d.ts`                                                 | installed-app-launcher.js 的 TS 类型面，包含启动/取消及结构化错误合同。                                                             |
| `packages/lcode-cua/motion-profile.d.ts`                                                         | motion-profile.js 的 TS 类型面，约束路径/运动参数。                                                                                 |
| `packages/lcode-cua/png.d.ts`                                                                    | png.js 的 TS 类型面，约束 RGB Buffer 到 PNG 编码合同。                                                                              |
| `packages/lcode-cua/runtime.d.ts`                                                                | runtime.js 的 TS 类型面；运行时和 broker/权限注入边界，不增加 transport 写入路径。                                                  |
| `packages/lcode-cua/xa11y-native-loader.js`                                                      | macos-cua-helper-app.mjs、Windows runtime staging 和对应测试复制的原生加载边界。                                                    |
| `packages/lcode-cua/xa11y-producer.d.ts`                                                         | xa11y-producer.js 的 TS 类型面，限定可达方法和原生数据结构。                                                                        |
| `apps/lcode-cli/scripts/shadow-replay.mjs`                                                       | 有 usage 的只读源库影子恢复/投影对账 CLI；源码说明先复制 DB 到临时目录，供交付验收。                                                |

## 其它告警的处置

64 项依赖声明均已核对：删除 26 项，保留 38 项。保留的精确名称在 Knip 的 workspace ignoreDependencies 中表达；对应消费者和逐项记录见 [审计数据](knip-remaining-audit-data.json)。隔离发行包的 node-pty require 从解压后的 package.json 解析，不是当前 workspace 漏装依赖；旧 OTLP 验收脚本另行删除，不抑制其失效的依赖。

58 项仅在文件内部使用的构建/维护脚本导出收为局部声明，声明、初始化和调用保持原样；23 项独立引用查询为零且无动态/公开入口的旧声明删除。此前 164 项导出也已绕过忽略规则重核，未发现外部消费者。

剩余导出逐项记录文件、名称、包再导出证据、外部文本命中路径、文件内标识符数量及保留理由。文本引用只是保守保留证据，不冒充符号级或运行时证明。内部实现及类型形状有实际用途，保留实现和当前模块边界；未充分证明可移除的兼容/迁移/类型边界不为清零删除。

重复导出包括 Goal/Target、workflow/ExpertWorkflow、schema 旧名、named/default、SSH/RemoteConnectionDialog、测试 seam 及相同协议值。它们共享实现或值，不是重复业务状态；保留原 import 形式与兼容名，逐组记录在审计数据中。

## 本轮最终结果

| 项目                         | 开工前 | 本轮结束 |
| ---------------------------- | -----: | -------: |
| 未使用文件                   |     54 |        0 |
| 未使用值导出                 |    572 |      491 |
| 未使用类型导出               |    273 |      273 |
| 未使用 dependencies          |     37 |        0 |
| 未使用 devDependencies       |     27 |        0 |
| 未声明依赖 / 无效路径 / 命令 |      0 |        0 |
| 重复导出                     |     38 |       39 |

- 原 54 个文件删除 3 个，保留 51 个；依赖删除 26 项，其余 38 项保留并表达真实装配用途。值导出减少的 81 项来自 58 项收为局部声明和 23 项无用声明删除。没有通过批量忽略源文件隐藏未核对实现。
- 重复导出多报告一项来自 `xa11y-native-loader.js` 成为可达入口后显现的原有 named/default 别名，未新增实现。配置提示和无效标签提示已清零，去掉重复入口与 3 个无效 `@lintignore`，保留具名接口导出。
- 本轮涉及 Desktop、UI、Services、CLI 及 workspace 依赖声明；不改变任何可变业务状态的 owner、写入路径或消息顺序。48 个受控旧源码文件相对本轮开工快照净减 462 行，不含 Knip 配置、维护工具、manifest、锁文件及审计文档。
- `pnpm knip` 仍因 491 项值导出、273 项类型导出和 39 项兼容重复导出以状态 1 退出，不称为全仓通过。逐项依据包括公开再导出、外部文本命中、文件内实现/类型使用和保守保留的兼容/迁移边界；文本证据不等同于完整符号或运行时证明。

## 实际验证

- 根 `pnpm typecheck`、`pnpm lint` 通过；Knip 配置单独携带 Node/JS 类型选项检查通过。
- CLI typecheck 27 个任务、lint 14 个任务通过。CLI 仍有原有 `core/src/tool/registry.ts:161` 的 `no-useless-fallback-in-spread` 警告及 Turbo workspace 锁索引提示，未写为无警告。
- 73 项定向回归通过，包括正式供应商 Adapter、用户 Key/网关、OAuth SDK fixture、构建/发行装配、原生平台策略和声明校验；补充的 45 项 Git 备份、Memory Extraction 和分叉回归通过，共 118 项。
- 两个保留模板在桌面/手机分别添加并保存 Key 的浏览器回归通过，模型仍存在；模板配置和官方网关实现与本轮开工快照逐字节一致。
- 冻结离线锁校验通过，没有新增包版本，只减少 2 个不再需要的包记录。格式及 diff 空白检查通过。
- 原 OTLP 验收工具的启动核验失败是确认其遗留状态的证据，已删除该工具；不将失败写成遥测回归通过。未执行真实付费模型、Docker/SSH、完整发行组装或 macOS/Linux 实机安装验收；这些保留工具的用途来自当前源码、调用方和规范，不冒充本轮执行结果。
