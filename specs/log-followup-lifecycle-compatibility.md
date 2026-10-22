# 2026-10-22 日志问题修复

## 规则与边界

用户进一步确认允许不需要证书的 ad-hoc 本机签名。macOS SEA 在移除 Node 原签名并完成 blob 注入后，必须执行本机签名及严格完整性验证，再生成资源清单和原子发布 bundle。复用 mise 与 Helper 的公共原生可执行文件签名函数；SEA 不启用 hardened runtime，不读取开发者证书配置、不联网、不做公证；后续明确启用 Developer ID 的打包流程仍可覆盖本机封印。失败不发布 staging。该要求来自 Node 官方 macOS SEA 创建步骤，不代表产品要求发行证书。

- 用户允许未签名发行包。共享 Helper 安装器的 `signaturePolicy` 默认 `optional`，不以 codesign、TeamIdentifier 或 Gatekeeper 为启动先决条件；显式 `required` 仍严格验证。Main 与 Host 复用该安装器。bundle 身份、真实路径、架构、资源清单、capability/generation 验证不变，不把 unsigned 表述为已签名。既有本地 dev 安装变体不变，不新增环境变量。
- broker socket 生成器同时预留 `.pip` 的 UTF-8 路径预算；macOS 不超过 103 字节，其他 Unix 不超过 107 字节。使用至少 128 bit 随机名，过长的显式目录在连接前报错，Windows named pipe 不受 Unix 限制。
- PiP service 是生命周期镜像及重连准入的唯一所有者。timer 与事件共用同一失败期限和重试间隔，同一凭据失败超过 30 秒后不再连接或逐事件告警。焦点事件不能重置期限；凭据 tuple 更新或所有活动 turn 结束后的新 turn 可开启新恢复期。终态同步更新镜像，dispose 后迟到 IO 不复活客户端。正常 live 事件与重连 snapshot 使用同一事实。
- GitReviewWorkspaceState 仍拥有审核状态。订阅建立监听后开始初始读取，同时观察两个异步任务的失败；取消、读失败和监听失败均终止 watcher，不产生未处理拒绝，按 revision 去重和 scope 隔离不变。
- Host 只释放自己拥有的资源。remote service collection 转发的 task/agent/session/file-watcher/terminal 代理不具有本地资源释放权；远端连接负责其 transport 生命周期。本地注册资源和订阅须明确登记清理。清理一个资源失败不能跳过其他资源，重复 dispose 复用同一完成结果。registry 等待全部连接清理完成后汇总错误；阶段同步抛错不妨碍后续阶段。嵌套 Error、cause、code、AggregateError 与循环引用可诊断，不再输出空错误对象。
- artifact URI 的纯 codec 放在 shared，CLI contracts 从公共入口重导出，供 CLI、UI Markdown 与 Host 共用。新写入保持 `lcode-artifact://`；只读兼容 `zcode-artifact://`，读、stat、附件解析、snapshot 和模型媒体投影均复用 codec。Markdown 的语法提取允许两个 scheme，最终授权仍精确核对当前 session。分享上传的新 wire 格式继续只接受规范 scheme。保持原 artifact/session/workspace 授权与目录隔离，不迁移数据库，不把未知 scheme 当 artifact。

## 所有者与时序

```text
Main/Host → 同一 Helper installer → 身份/架构/资源验证 → optional/required 签名策略 → 安装
Agent lifecycle / Main focus → PiP service 同步镜像 → 同一恢复准入 → 认证 client / snapshot
审核订阅 → watcher + initial read（立即共同观察）→ revision 投影 → dispose/失败 → abort
Host shutdown → registry → 各连接本地资源 → 连接 transport → 全部落定 → 聚合失败
                                                        ↓
                                       后续本地 Host 清理阶段仍执行
Desktop continuous ──┐
Mobile replayable ───┴→ 同一 Host 审核 owner；不改 stream/replay/lease 协议
旧/新 artifact ref → contracts codec → 现有存储/附件 owner → 同一 ID 与授权路径
```

## 回归验收

1. production unsigned Helper 可安装；错 bundle/架构仍拒绝；required 模式保留验签和原子回滚。
2. 长 macOS 临时目录生成 broker/PiP 均在字节预算内；多字节目录正确计算；不能容纳随机名时报明确错误；Windows pipe 和真实 socket 连接测试通过。
3. PiP 连续 focus 不绕过 deadline/间隔；凭据轮换恢复最新快照；终态和 dispose 不复活旧 turn/client。
4. 真实 fs.watch 在初读挂起期间 abort，无 unhandledRejection/rejectionHandled；初读失败也释放监听；原跨窗口/桌面与手机投影回归通过。
5. remote 退出不对代理发送 dispose RPC；清理失败后仍关闭 transport，所有 registry 项均落定；同步 throw、异步 reject、超时、重复释放与嵌套错误回归通过。
6. 旧 URI 经真实 artifact 存储和附件 read/stat/snapshot/model 路径读取；新 URI 写入不变，未知 scheme 与非法引用拒绝。

## 验证限制

Windows 执行单元、真实文件/进程/浏览器回归及生产构建。macOS 签名工具、TCC 与原生 PiP 需 macOS 实机确认，不把注入测试表述为原生通过。

## 实现与实际验证

- 修复共享 Helper 安装策略、SEA 注入后的本机封印、Unix socket 字节预算及 PiP 事件/timer 共用的恢复准入。保留固定身份、资源清单、架构、capability/generation、终态与 dispose fence。
- 修复 Git watcher 初读期间取消的 detached rejection；原 desktop continuous 与手机 replayable 状态 owner、revision 和恢复边界不变。
- Host 统一登记借用资源与本地订阅，有序清理会收集全部失败。真实 `ProxyChannel.toService` 会为不存在的 `disposeAllAndWait` 返回函数，因此 `typeof` 不能证明释放权；回归确认退出不再发送此非契约 RPC。registry 等待全部连接落定，取消订阅失败仍关闭物理连接，重复释放复用结果。
- shared 的纯 URI codec 由 CLI contracts 重导出，所有旧引用读路径、snapshot、模型媒体、Markdown 授权共用；真实临时 artifact 存储验证读取、二进制与 stat，跨会话 Markdown 授权仍被拒绝。

验证运行时：Windows、Node 24.21.0、pnpm 10.34.6。最终结果：

| 验证                                                       | 结果                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm typecheck`（含 Renderer、preload 与 Renderer 测试）  | 通过                                                              |
| `pnpm lint`                                                | 通过，0 警告                                                      |
| `pnpm --dir apps/lcode-cli typecheck`                      | 27 个任务通过                                                     |
| `pnpm --dir apps/lcode-cli lint`                           | 通过；保留 `core/src/tool/registry.ts` 的 1 条既有 spread 警告    |
| `pnpm architecture:check --changed`                        | baseline 0 / 新增 0 / 总违规 0                                    |
| `pnpm --dir packages/lcode-cua test`                       | 187 项通过                                                        |
| `pnpm test:remote-control`                                 | 181 项通过                                                        |
| `pnpm test:release`                                        | 159 项通过，含新增 macOS 封印/Helper staging 与既有 mise 签名回归 |
| CLI artifact、附件、空输出、模型选择持久化与上传回归       | 29 项通过                                                         |
| 公共 schema、OAuth 插件及原生 OpenAI/Google 协议回归       | 19 项通过，Git 五分支完整                                         |
| `pnpm test:renderer:ui`                                    | 5 项真实隐藏 Electron 回归通过                                    |
| `window-host-recovery.e2e.test.mjs`                        | 真实 Electron Utility exit 5 恢复通过                             |
| Desktop `build:no-runtime-assets`                          | 生产构建通过；保留既有 chunk 体积/混合动态导入提示                |
| `node scripts/build-desktop-agent-cli.mjs`（校验发行输入） | Agent、插件重建及 Windows bundle staging 通过                     |

上述测试按命令统计共 581 项通过。新增失败场景先复现再修复，包含 production unsigned、长/多字节 socket、focus 风暴、真实 fs.watch 取消、同步清理抛错、嵌套 Error 和历史 artifact 读取。发行检查曾拦截旧 worker/输入摘要，已使用标准 worker 与 notices producer 同步后完整重跑通过，没有跳过检查或修改材料缺口 baseline。

这些结果证明当前源码和本机构建，不代表旧安装版已升级。macOS codesign/SEA/TCC/原生 PiP 的测试使用注入 seam 与真实目录，尚未进行 macOS 实机或已安装发行包验收；没有对真实远程机器执行退出/部署操作，也没有据此断言历史每次 Host 退出均具有同一根因。
