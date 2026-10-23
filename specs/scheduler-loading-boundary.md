# Scheduler 的最小加载入口

Scheduler 仍为独立常驻 utility process，保留 AutomationRepo / OffPeakTaskRepo 的事务、claim、退出释放和 Main 派发边界。它只依赖 tasks-index Repo 和 cron 计算，不需要加载执行 Agent、插件、终端或 CUA 装配。

services 新增公共 `@lcode/services/scheduler` 入口，直接 re-export 当前两个 Repo 和 cron 的 `computeAutomationNextRunAt`、`isOneShotAutomation`，不复制实现、不增加持久 owner。原 `/node` 导出兼容保留。Desktop Scheduler 只更换此导入，不改变 Main/Host 的服务注册和状态。

验收：构建入口的实际输出图中不存在 Agent/插件/终端/CUA 实现；同一工具链记录 broad/narrow bundle 大小和贡献模块数（不等同 RSS 收益）。现有调度 claim、结算、故障恢复和关闭回归通过。导出的函数和 Repo 仍来自原实现文件。
