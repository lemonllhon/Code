# Scheduler 的最小加载入口

Scheduler 仍为独立 utility process，按原 AutomationRepo 的真实需求驻留，保留事务、claim、退出释放和 Main 派发边界。它只依赖 tasks-index Repo 和 cron 计算，不需要加载执行 Agent、插件、终端或 CUA 装配。套餐专用闲时调度已随 Coding Plan 移除。

services 公共 `@lcode/services/scheduler` 入口直接 re-export 当前 AutomationRepo 和 cron 的 `computeAutomationNextRunAt`、`isOneShotAutomation`，不复制实现、不增加持久 owner。原 `/node` 导出兼容保留。Desktop Scheduler 使用此入口，不改变 Main/Host 的服务注册和状态。

验收：构建入口的实际输出图中不存在 Agent/插件/终端/CUA 实现；同一工具链记录 broad/narrow bundle 大小和贡献模块数（不等同 RSS 收益）。现有调度 claim、结算、故障恢复和关闭回归通过。导出的函数和 Repo 仍来自原实现文件。

按需驻留接口与事件顺序见 `desktop-idle-resource-optimization.md`。Main 在数据库 ready 后向 Host 查询；Repo 的成功写入通知 Host 使观察失效。Scheduler 自身验证无 enabled/claim/未结算 run，且 tick、settlement、inFlight 均已排空才退出；Main 以真实 exit 释放唯一进程 owner 并重查需求。Host 未就绪时不抢先打开库；读取异常保守保留可用性。账号预热与会话 runtime 不参与 Scheduler 的回收判定。
