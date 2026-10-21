# 远程工作区连接与任务状态可见性

## 产品规则

- SSH、WSL、Docker 项目行持续显示连接方式和文字状态：未连接、连接中、已连接、连接失败。已连接必须由当前 attachment 的 `rpcReady` 证明，不能仅凭 tab 保存的 sessionId。
- 连接中复用已有连接日志展示真实探测、下载、部署和握手进展，不推算百分比。失败保留错误详情、复制及重试；取消和迟到结果规则不变。
- 远程项目下的会话和置顶、时间线中的远程会话复用 Window Host Controller 的任务列表，消费与本地相同的实时 activity。禁止用独立历史缓存替代实时状态。
- 远程会话显示文字状态：准备中、运行中、后台运行、已完成、已中断、失败。待确认优先复用现有交互 badge；后台工作未结束时不能只显示已完成。
- attachment 离线时明确显示离线，不将冻结的 running activity 当作当前执行证明。没有实时 activity 的历史 completed/error 可以显示对应终态；遗留 persisted running 显示状态待同步，不能伪造运行中。
- 项目、置顶和时间线同源，同一路径下的 SSH、WSL、Docker 必须按 `workspaceIdentity?.trim() || workspacePath` 隔离。项目收起时仍保留未读提示。
- 中文、英文、所有主题及窄屏复用现有字号和语义颜色；状态与项目折叠、菜单、重连操作互不覆盖。

## 所有者、接口与迁移边界

| 数据                                  | 唯一所有者            | UI 读取接口                                         |
| ------------------------------------- | --------------------- | --------------------------------------------------- |
| 物理连接、logical session、attachment | 窗口 Host 连接注册表  | 既有 workspace resolver 的 rpcReady                 |
| 当前重连请求、错误和部署日志          | 既有 Root 重连流程    | reconnecting keys / error / logs props              |
| 会话 phase、待确认和后台工作          | 远端 Agent/runtime    | Host Controller activity，经 useGlobalTaskList 投影 |
| 任务成员、未读和历史终态              | source 的 tasks-index | Controller listTaskList / task frames               |

Renderer 只派生显示，不新增连接或任务状态 store，不增加轮询、计时器或状态写路径。远程置顶和时间线从独立历史读取切换到已存在的 Controller 聚合接口；既有 mutation 兼容路径不作为状态展示事实源。协议、owner/lease、CommandInbox、runtime admission 与持久化 schema 均不变。

```mermaid
sequenceDiagram
  participant Registry as 窗口连接注册表
  participant Agent as SSH/WSL/Docker Agent
  participant Controller as 窗口 Host Controller
  participant UI as 侧栏
  Registry-->>UI: 当前 attachment / 重连进度
  Registry->>Controller: 按 identity/session 解析 source
  Controller->>Agent: 订阅 sessions-index（existing-only）
  Agent-->>Controller: running → waiting → completed/error
  Controller-->>UI: tasks-index 投影与 activity
  UI->>UI: 同源显示连接状态、任务状态与未读
  Registry-->>Controller: 断连或换代
  Controller-->>UI: offline / 当前代投影
```

Desktop 保持 `desktop-continuous`，手机保持 `web-remote-replayable`，均读窗口 Host 的同一 Controller；重连沿用原有水位、snapshot/gap repair 与 stale generation 防护。

## 验收场景

1. SSH、WSL、Docker 分别覆盖连接中、已连接、失败、未连接及有旧 sessionId 的断连；连接状态持续可见，连接中可读部署日志，失败仍可重试。
2. 实际侧栏组件的远程任务依次收到运行、待确认、完成、中断、失败与后台工作投影，不打开会话也能更新；置顶与项目视图均保留 activity。
3. 同路径的本地和三个远程来源具有相同 taskId 时仍互不污染；Controller 查询携带各 scope，远程旧历史缓存不能覆盖它。
4. 断连冻结 running 投影只显示离线，重连后读取当前代；无 activity 的历史 running 不转圈，历史终态可读。
5. 宽屏、390px、明暗主题、中英文，项目折叠、重连和菜单正常；实际执行 E2E 与针对状态派生的测试。
6. 执行根 typecheck、lint 和 changed architecture check，真实 SSH/WSL/Docker 环境未执行时单独说明。

## 验证记录（2026-10-21）

- 新增浏览器回归先复现远程项目缺少连接状态，再验证三种连接的实时任务状态、旧历史缓存隔离、断连、重试、日志以及项目收起后的未读提示。中英文、390px 暗色与宽屏浅色均通过。
- 本次关联的浏览器回归共 11 项通过：新增状态 2 项、侧栏动效 2 项、组织侧栏 2 项、焦点筛选 3 项、工作树侧栏 2 项。组织场景首轮在文件格式化触发热更新时被重载中断，文件稳定后独立重跑通过。
- `pnpm test:remote-control` 137/137 通过，覆盖三种连接的 owner/identity、取消、换代、多设备和手机 replayable 恢复。状态派生与 Controller 投影定向测试 5/5 通过。
- 最终根 `pnpm typecheck`、`pnpm lint`、本次文件格式检查及 `git diff --check` 通过；新 fixture 的独立类型检查通过。首轮类型检查曾包含本次测试写法及其他本地 Git 审核测试的错误，最终复查已无错误。
- 架构检查起点和最终均为 baseline=0 / new=0。实现位于 ui 模块、测试位于 web；沿用上图的既有 owner 与事件顺序，未新增运行状态 store、订阅或轮询。生产实现及本次本地化合计 +184/-178，净增 6 行，不含测试、spec 与其他本地改动。
- 本机 Windows 浏览器验证；未连接真实 SSH 主机、WSL 发行版或 Docker 容器执行作业，未做 macOS/Linux 实机验收。未打包或替换已安装应用。
