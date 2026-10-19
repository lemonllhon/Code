# 模型流与工具流水线验证记录

2026-10-19，Windows，Node v24.21.0。P0-A/P0-B/P1 已完成代码及本地验收；行为契约见 [spec](../../specs/model-stream-tool-pipeline.md)，设计依据见 [方案](../plans/model-stream-tool-pipeline.md)。

## 性能结果

| 场景                 | 对照 P50 / P95 / P99        | 新路径 P50 / P95 / P99   | P95 降幅 |
| -------------------- | --------------------------- | ------------------------ | -------- |
| SQLite，2,256 parts  | 15,554 / 16,273 / 16,719 ms | 27.8 / 34.2 / 36.0 ms    | 99.79%   |
| SQLite，10,000 parts | 67,726 / 73,245 / 73,245 ms | 252.9 / 258.3 / 258.3 ms | 99.65%   |
| 工具慢快混合，并发 2 | 124.3 / 139.7 / 140.7 ms    | 94.0 / 95.7 / 109.3 ms   | 31.47%   |

原始数据：[SQLite JSON](model-stream-tool-pipeline-2026-10-19.json)、[工具 JSON](tool-scheduling-2026-10-19.json)。

SQLite 对照是逐条调用 savePart 的自动提交路径，代表旧 Runtime 的调用方式；新路径为同一个 store 的 saveParts。使用真实临时 SQLite 文件和生产默认配置，不改持久性、不改数据库结构。初始化和 migration 在计时外，每次采样使用独立文件；保存后的 ID、类型、全文和签名做摘要一致性校验，数量必须相同。2,256 组每条路径预热 5 次、采样 20 次；10,000 压力组预热 2 次、采样 5 次，其 P95/P99 均为样本最大值，不能作为稳定尾延迟估计。

每条路径另取一份插桩样本：next-sequence 读取与 session touch 从 N 次减少到 1 次，新路径一次显式事务提交。对照 explicitCommits=0 表示使用自动提交，不表示没有磁盘提交。批量确定性回归另外验证中途异常整批回滚、另一个连接读不到半批、重交不增行、归属不符不写入。

事件循环探针为写入开始前排入的 setImmediate 完成时间，测量“下一轮事件循环等待”，不是 event-loop histogram：2,256 组 P95 从 16,273.5ms 降至 34.3ms；10,000 组从 73,245.1ms 降至 258.4ms。SQLite 仍同步执行；10,000 个真实合法块仍会一次占用约 258ms。2,256 组满足方案 P95 ≤ 200ms 且下降 ≥ 90% 的门槛。

工具基准使用真实 ToolScheduler/ToolExecutor、权限和结果序列化；handler 是受控的 [60,5,5,60]ms 异步任务。对照只把计划恢复为旧固定两项波次，新路径按当前逻辑阶段补位。两条路径都预热 5 次、采样 20 次，并断言最大实际并发=2、全部成功、返回顺序不变。Windows 定时器和系统负载会影响绝对值；无外部网络/真实工具进程，不能把 31.47% 外推为所有任务的端到端收益。

## 回归与门禁

统一入口：

```powershell
node scripts/test-model-stream-tool-pipeline.mjs --browser
```

最终组合执行 **164 项通过，0 失败、0 跳过**；包含 6 项浏览器父/子用例。新增投影 fixture 的严格类型已补全，并通过 bootstrap 单包及整个 CLI 类型检查。

覆盖实际安装 SDK 的 ESM/CJS 和 bundle fixture、10,000 空数组 delta、正文/真工具边界、usage、签名、非法 schema、传输失败与 AbortError；批量内容成功/取消及失败屏障；SQLite 原子性与旧单条/fork 行为；共享上限、100 项候选保持默认 10 路、补位、审批、终态、取消后真实清理和结果声明序；流式 Read/Write 屏障、去重及恢复；Desktop continuous / 手机 replayable 的队列、启动、补位、停止和快照重接。

浏览器使用 Chromium，1280×800 与 390×800：实际行组件展示一条完整思考、12 个工具中 2 个 running/10 个 pending、补位、停止和切换后重挂载；另执行既有 336 行长历史时间线。fixture 传入合成权威行；实际 executor → ProductProjection → delta/snapshot 的对应关系由独立 CLI 集成用例验证。pending 的既有活动动画不用于判定运行事实，浏览器检查公开 data-status。

根目录 `pnpm typecheck`、`pnpm lint`，CLI `pnpm --dir apps/lcode-cli typecheck`、`pnpm --dir apps/lcode-cli lint` 均通过。架构检查 violations/baseline/new 均 0；CLI target 包含真实 tsc 重编译，其余有缓存命中。Turbo 的子 workspace lockfile 闭包告警仍在。

架构归属为 lcode-cli（contracts/core/adapters/bootstrap），另有根 scripts 与 Web test fixture；没有新增跨模块实现依赖。目标文件集合共 43 个，相对 HEAD 的增加/删除/净行数为 2665/462/+2203（含 22 个未跟踪新文件及文档、原始基准 JSON）。重叠文件含用户既有改动，该数值用于评审目标集合，不能当作本任务独占改动量；无关本地改动已保留。

第三方 patch 与锁文件 hash 已通过原生成器同步，THIRD-PARTY-NOTICES 正文无变化。agent esbuild fixture 验证当前解析链路包含补丁；未启动实际安装版、未重启当前桌面实例、未进行三平台安装矩阵或真实账号会话回放。性能结果是本地受控组件基准，不能视为原历史会话的精确总耗时预测。

## 复现基准

```powershell
node --import tsx scripts/bench-model-stream-tool-pipeline.mjs docs/benchmarks/model-stream-tool-pipeline-2026-10-19.json
node --import tsx scripts/bench-tool-scheduling.mjs docs/benchmarks/tool-scheduling-2026-10-19.json
```

逐条保存对照需要数分钟。脚本只清理其自行创建且已验证位于系统临时目录的数据库目录，不访问用户会话数据库。P2 的模型往返/工具说明优化未纳入本轮。
