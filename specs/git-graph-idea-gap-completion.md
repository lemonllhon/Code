# Git 图谱与 IDEA 参照差距收尾

状态：2026-10-21，已列出的 G1–G4 功能全部落地，本机自动化验证完成；用户构建后再进行构建版、原生系统与手机真机验收。

## 交付清单

| 批次            | 已完成内容                                                                                                        | 规则                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| G1 布局         | 窄侧栏保留泳道与 Ref、历史自适应高度、紧凑筛选、固定表头、可调整历史/详情及文件/Diff 分区                         | [布局](git-history-layout.md)                     |
| G2 交互         | 分支/远端/Tag 与作者候选、目录树和状态数量、列宽拖动/键盘/复位、提交与目录键盘导航、右键/Shift+F10/手机更多       | [交互](git-history-interactions.md)               |
| G3 搜索与大历史 | 消息正文/Hash 统一检索、ERE 正则/大小写、提交定位、行与图形视区渲染、明确分页上限                                 | [检索与性能](git-history-search-performance.md)   |
| G4 高级历史     | 最多 32 项复选、按确认顺序批量 Cherry-pick/Revert、独立 Merge 主线、soft/mixed/hard Reset、备份引用与状态绑定恢复 | [历史操作与恢复](git-history-advanced-actions.md) |
| 细节收尾        | 12–20px 字号对应行高、七种主题、中英文 Diff 上下文提示/键盘展开、完整 Ref/Hash/作者/日期提示、焦点与跨入口一致性  | 上述 spec 与测试                                  |

手动“提交审核”和任务完成后“生成并打开审核”继续直接进入同一个右侧面板。旧审核弹框没有恢复；原 A–F 功能及与本轮无关的本地改动保持。

## 所有者与写入边界

- `useGitHistory` 持有当前 Host/attachment/identity 的唯一页面、详情、文件与确认投影。候选、筛选、目录折叠、列宽、视区与复选集合为 UI 局部状态，不持久化为服务端事实。
- 查询只读；分页绑定 refs/filters revision，迟到响应按原 scope/token 丢弃。定位先解析目标、读取其历史与详情，成功后一起更新界面。
- 批量操作使用原 preview/start/continue/abort、同一原生 sequencer、journal 与 integration reservation。Merge 主线独立于只读 parent Diff，不暗选。
- Reset 使用原独占 repository/checkout 协调和 journal。先留旧 HEAD、tracked 工作树与暂存区的恢复引用，再写入；成功状态未变化才允许自动恢复。未知结果只核对原收据与原生现场；孤儿进程继续占有 writer，不能自动重放或释放。
- 未在用户工作仓库执行 Reset/摘取/撤销来演示。原生测试均使用隔离临时仓库；没有 commit 或 push。

## 验证记录

| 检查                        | 真实结果与证据                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 图谱原生/协议/树模型        | 33/33 通过：[日志](../artifacts/git-review-pane/graph-completion-native.tap)                                                                                             |
| 通用整合、协调与 journal    | 24/24 通过：[日志](../artifacts/git-review-pane/graph-completion-boundaries.tap)                                                                                         |
| 图谱交互 E2E                | 26/26 通过：[日志](../artifacts/git-review-pane/graph-completion-history.tap)                                                                                            |
| 手动/自动审核、文件操作 E2E | 22/22 通过：[日志](../artifacts/git-review-pane/graph-completion-pane.tap)                                                                                               |
| 整合页 E2E                  | 8/8 通过：[日志](../artifacts/git-review-pane/graph-completion-integration.tap)                                                                                          |
| 搜索错误补验                | 2/2 通过，包含无效范围表达式与原生超时的不同归因：[日志](../artifacts/git-review-pane/graph-completion-search-edges.tap)                                                 |
| Reset 恢复补验              | 备份 ref 篡改、新改动、stale/hard 确认边界：[日志](../artifacts/git-review-pane/graph-completion-reset-edges.tap)                                                        |
| 类型/Lint/架构/格式         | `pnpm typecheck`、`pnpm lint` 通过；架构 baseline/new 均为 0；本轮 57 个文件格式检查通过。证据见同名前缀的 `typecheck.txt`、`lint.txt`、`architecture.txt`、`format.txt` |

原生用例覆盖顺序与幂等、批次第二步冲突后继续/中止、todo 篡改、SSH 签名 Tag、三个 Reset 模式、staged/unstaged 恢复、mixed 新增文件恢复、移动备份 ref、unknown/orphan。浏览器覆盖远端 identity、迟到响应、右键实际行、Merge 主线、hard 二次确认、候选、列宽、目录、键盘、分隔条、390/512/1280px、短窗口、七种主题及最大字号。10,050 条渲染用例验证可见 DOM 有界，不据此宣称任意规模/拓扑性能无上限。

## 实际界面与后续验收

- [真实仓库快照的右侧面板与 Diff](../artifacts/git-graph-completion/real-repository-diff.png)：当前生产组件，只读 150 条历史快照；详情限前 6 提交、各前 3 文件，预览桥不执行实时 Git 写入或筛选。
- [宽屏界面](../artifacts/git-history/desktop.png) 与 [最大字号窄屏](../artifacts/git-history/font-20-mobile.png)：生产组件加隔离测试 Host，用于验证交互和响应布局。
- 本轮相对开工基线的文件与净行数见 [变更清单](../artifacts/git-review-pane/graph-completion-delta.json)；模块为 UI、Services、Shared，未变更状态所有者或扩张架构 baseline。

剩余验收为用户构建后的安装包、Windows/macOS/Linux 原生交互、真实远端连接及手机真机。此清单中的代码功能无待办；不将源码预览或模拟 Host 测试记为构建版验收。
