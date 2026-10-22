# SSH 复用设置页代理

## 产品规则

- SSH 连接向导使用一个“代理模式”选择器，不再保留独立开关。默认选“直连（不使用代理）”；选择设置中的默认代理或代理库条目，即启用并复用其地址、账号、密码和 CA，无须重复填写。
- 设置页继续唯一拥有代理地址、认证信息和自定义 CA。UI 草稿只有一个选择值（直连、默认代理、代理 ID）；提交后目标和历史仅携带 `useProxy` 与可选 `proxyProfileId`，不复制代理 URL 或凭据。
- 列表通过本机基础服务的 `IProviderSettingsService.getView/onDidChange` 读取代理库，不能随当前远程 workspace 切到远端代理库。选项展示名称及去除 userinfo 的地址；保留加载、失败重试和所选代理被删除提示，不自动切换到其他代理。移除选择器下方的常驻复用说明和空库提示，中英文一致；空库仍可选择直连或设置中的默认代理。
- 支持已有设置中的 `http://`、`https://`、`socks5://`，包括 percent-encoded 账号密码。HTTP(S) 使用 CONNECT 隧道；HTTPS 验证代理证书并复用设置中的自定义 CA；SOCKS5 的目标域名由代理解析。
- 选择直连及旧历史缺省字段均沿用直连。`useProxy: true` 且缺省 ID 的旧历史兼容默认代理；指定 ID 必须精确匹配本机代理库。所选代理已删除、默认代理未配置、协议无效、认证失败或隧道失败均明确失败，不回退默认代理或直连。
- 显式 SSH 代理模式使用所选配置自身的 CA；HTTP 请求的 No Proxy 列表不改变这个显式选择。此选择只控制本机到 SSH 的 TCP 隧道，不修改远端 Agent 的 HTTP 代理环境。
- 新建物理连接时由本地 Window Host 读取最新设置；设置变更不打断已有 SSH 连接。历史恢复保留选择并按 ID 重新读取当前配置，不保存旧代理副本。

### SSH 配置布局（2026-10-22）

- 新建连接直接进入带 SSH/WSL/Docker 切换的表单。配置别名、主机、认证、代理配置与资源下载方式均在主表单直接显示，无需展开；下载按钮简写为“本地上传”“远端下载”，并排显示、文字可换行，完整下载语义及远端工具要求保留在悬停提示中。取消常驻长说明以节约空间，原选择值和提交语义不变。
- 表单顶部将“SSH 配置别名（可选）”与“资源下载方式”并排放置，标签与控件顶边分别对齐，别名控件继续不超过 224px。窄屏使用纵排，资源下载方式紧随别名、位于主机之前；代理继续直接显示。
- 主机和端口在桌面与窄屏均保持同排，主机占剩余空间，端口使用 5.5rem 紧凑列以容纳五位端口号；320px、大字号下仍可编辑，不增加独立端口行。
- 代理模式沿用普通字段布局，移除额外卡片边框与内边距。SSH 字段组之间采用 8px 间距，配置表单与底部操作之间采用 12px 间距，保留现有控件高度与键盘焦点。
- 别名框最大宽度缩至 224px，有可用别名但未选择时显示“不使用别名”，没有时显示“暂无别名”，不再把同一空状态同时放在框内和框下。只有加载过程中禁用；空列表仍可打开搜索和选择“不使用别名”，空状态在展开列表中展示。别名仍来自本机 SSH 配置，不将任意搜索文字提交成未经解析的别名；已有别名继续通过原 `applySshConfigAlias` 回填连接字段，读取失败仍显示错误。
- 默认首屏优先呈现主机与认证；中英文均可直接操作代理配置与两种资源下载方式。手机和大字号继续使用原表单滚动区，底部按钮独立可达。
- 此次只调整 UI 布局和提示。`useRemoteConnectionForm` 继续唯一拥有代理、认证及下载方式草稿，选择仍调用原 setter 并由原连接接口提交；设置服务、加载失败重试、所选代理删除报错、Host/lease 和远端交付顺序不变，无持久化迁移。

## 所有者与接口

- UI 的 `useRemoteConnectionForm` 唯一拥有选择草稿，`buildRemoteTarget` 将其映射成 `SSHConnectOptions.useProxy/proxyProfileId`。组件经 hook 读取本机代理库投影，不维护第二份代理配置。
- `RemoteTargetSnapshot`、设置校验与工作区目录转发保留模式和 ID；workspace identity、remoteSessionId 和既有 SSH 主机身份不变。
- `sshConnectOptionsSchema` 是 Desktop Main、Main → Host 和 Web 连接入口共用的运行时校验；必须保留并校验 `useProxy` 与 `proxyProfileId`，不能静默剥离。缺省字段继续直连，非法类型或空 ID 拒绝。
- `remoteTargetSchema.ts` 唯一声明 SSH/WSL/Docker 连接字段及运行时校验；`remoteTarget.ts` 的连接类型从 schema 推导，`SSHRemoteTargetSnapshot` 从连接类型剔除临时 secret 后扩展凭据引用，设置历史 schema 也通过同一连接 schema 的 `omit/extend` 派生。公开导出路径兼容现有调用方，不再分别维护连接与历史的字段清单。
- 远控项目目录仅是 endpoint 的展示投影，由共享 `createWindowWorkspaceCatalogTarget` 按字段白名单生成；不发送代理模式、代理 ID、认证字段、密钥路径或部署选项。Host 注册表和桌面历史继续持有完整选择；手机通过 identity 请求既有桌面 owner 重连，不能从目录重建连接参数。目录仍用严格 schema 校验，不放宽未知字段。
- Window Host 物理连接注册表区分直连、默认代理及各代理 ID，避免同一 SSH 主机跨代理复用 socket；同选择继续使用现有池、owner 和取消语义。
- `@lcode/provider-node/network` 提供窄的代理 socket adapter：接收目的 host/port、设置中的代理 URL、可选 CA、取消信号与有界握手超时，返回暂停读取的 socket。失败只返回安全错误，不携带 URL、userinfo 或第三方 options/cause。
- Host 将 socket 工厂注入 `createRemoteBackend`，server 的 SSHBackend 只消费工厂，不读取全局设置。单次握手 singleflight，SSH 认证开始后才恢复 socket 读取。
- SSHBackend 拥有隧道 socket 与建连取消控制器。取消/释放时终止在途代理握手及 socket；迟到完成必须销毁，不得继续 SSH 认证或复活已释放 backend。
- 桌面 continuous 与手机 replayable 继续复用桌面既有 attachment 和会话运行时；此功能不增加远程 Host、Agent、任务队列或恢复通道。

```mermaid
sequenceDiagram
    participant U as SSH 表单草稿
    participant H as Window Host / 物理连接池
    participant S as 设置服务
    participant P as 代理 socket adapter
    participant B as SSHBackend
    S-->>U: 本机代理库视图 / 更新事件
    U->>U: 选择直连 / 默认代理 / 代理 ID
    U->>H: 连接目标 + useProxy / proxyProfileId
    H->>H: 按 SSH 主机及所选代理去重
    alt 新物理连接且开启代理
        H->>S: 按 ID 读取当前代理，或读取默认代理和 CA
        H->>B: 注入代理 socket 工厂
        B->>P: 建立可取消隧道
        P-->>B: 暂停读取的 socket
        B->>B: 接入 ssh2，恢复读取，执行 SSH 认证
    else 直连
        H->>B: 使用原 SSH 连接路径
    end
    U->>H: 取消最后一个等待者
    H->>B: dispose
    B->>P: abort / destroy
```

## 验收

1. UI 在宽屏和 390px、中英文显示单个选择器；切换直连、默认代理和不同代理后提交目标正确，不出现开关或重复代理地址/密码输入。加载失败可重试，删除所选代理不静默改选。
   - 已保存代理与空库均不显示已移除的两段说明，选择器没有指向已删除说明的 `aria-describedby`。
   - 在 1280×720 下检查别名与资源下载方式的标签、控件分别水平对齐；390px 下紧邻纵排，两者均位于主机之前。主机与端口在 320px / 390px / 桌面均同排，端口列紧凑、无横向溢出。代理与资源下载方式直接显示，可选择两种下载模式且提交值正确；保留主题与键盘选择回归。
   - 别名列表为空时仍能展开、搜索并返回“不使用别名”，折叠时没有重复空提示；有别名时可搜索并回填真实表单；读取失败提示仍可见，不能将任意搜索字符串当作已解析配置。
2. 真实本地 HTTP、HTTPS、SOCKS5 代理隧道可完成 SSH 认证和命令；代理认证正确，包含特殊字符的账号密码正确编码/解码。
3. HTTPS 自定义 CA 生效，不关闭证书验证；错误认证、非成功 CONNECT、缺失/无效配置及超时均失败且不泄露凭据，不访问目的主机的直连路径。
4. 取消在途握手、并发请求与迟到结果不泄漏 socket、不重复认证；原 SSH 直连仍可用。
5. 直连、默认代理和不同代理 ID 不共享物理连接，同一 ID 保持去重；历史、设置 schema 和恢复保留选择，缺省旧记录保持直连。已删除代理 ID 明确失败，代理库更新后新连接读取最新配置。
6. 类型、Lint、架构检查和已有连接取消/恢复回归通过。
7. 代理目标经过真实连接 schema、Host 消息校验后仍使用所选代理完成 SSH 认证。相同目标经过 Host 目录投影与 RPC 后能被手机严格校验接收，既不报 `unrecognized_keys`，也不泄露连接设置；原始 Host 目标不被修改。

```mermaid
flowchart LR
  Draft[桌面代理选择草稿] --> Validate[共享连接 schema 保留并校验模式及 ID]
  Validate --> Host[Window Host 注册表 / 连接 owner]
  Host --> Proxy[读取本机设置并建立代理 SSH]
  Host --> Projection[共享目录白名单投影]
  Projection --> Catalog[严格目录 schema / scoped RPC]
  Catalog --> Mobile[手机展示已有项目]
  Mobile --> Identity[仅 path / identity 的重连请求]
  Identity --> Host
```

## 本轮验证

### 2026-10-22 顶部字段与窄屏主机端口对齐

- 别名与资源下载方式在桌面同排，标签和控件顶边分别对齐；窄屏紧邻纵排。主机与 5.5rem 端口列在所有宽度同排，320px / 20px 字号下五位端口号仍能完整显示。
- 两份浏览器回归共 11 项通过，覆盖中英文、七主题、1280px / 390px / 320px 与大字号，继续验证代理选择、别名回填、下载模式提交与键盘操作。已检查中文桌面和窄屏截图；滚动几何断言按实测整数舍入使用 1px 容差，不增加生产延时或同步分支。
- `pnpm typecheck`、`pnpm lint`、相关文件格式与 diff 检查通过；changed architecture 的 total / baseline / new 均为 0。
- 本轮布局调整位于原 UI 字段组件，生产源码净增 4 行，并更新两份 spec 与两份浏览器回归。草稿、代理事实和提交的所有者及上图事件顺序保持不变，不增加状态、协议或 IO 路径。本轮未构建安装包。

### 2026-10-21 SSH 配置密度与别名空状态

- 先由浏览器复现两段代理说明仍显示、空别名框被禁用，再调整现有字段投影；别名按用户确认只搜索、选择本机已有配置，空库显示“暂无别名”。
- 三个现有浏览器测试文件共 18 项通过：1280×720 / 390px 中英文布局、别名与下载方式同排或纵排、下载选择后滚动区仍在顶部且提交值正确、空别名搜索、有别名回填、读取失败，以及七主题 / 大字号和 SSH / WSL / Docker 取消与迟到结果回归。已人工检查中文桌面与英文窄屏截图。
- `pnpm typecheck`、`pnpm lint`、改动源码及测试格式检查通过；changed architecture 的 total / baseline / new 均为 0。
- 变更位于 legacy ui、Web 浏览器测试和本 spec；UI 源码净增 6 行，浏览器测试与夹具净增 130 行。草稿仍归 `useRemoteConnectionForm`，代理事实仍归本机设置服务；沿用上图事件顺序，没有新的协议、状态副本或 IO 路径。此次完成源码与隔离浏览器验证，未构建安装包。

### 2026-10-17 连接、目录与持久化边界修订

- 原始 `windowWorkspaceCatalogSchema` 对 Host 发出的 target 精确复现 `[0, "target"]` 的两个未知字段；原连接 schema 则复现代理字段被静默剥离。新增边界测试先失败，再统一 schema 与目录投影。
- `pnpm test:remote-control` 133 项、`pnpm test:sidebar-collaboration` 61 项、真实 HTTP/HTTPS/SOCKS5 连接及代理/历史回归 15 项通过；Worker typecheck 与 45 项回归通过。浏览器 5 项覆盖 1280/390px 的目录、重连、错误隔离及失联移除，已知工作树保持禁止移除。
- 根 `pnpm typecheck`、`pnpm lint`、架构检查通过；schema 的现有 Desktop IPC / Web 调用经 `dep:refs` 确认，公开导出保持兼容。修改范围涉及 shared、desktop、ui、测试与现有构建产物，所有者及事件顺序见上图。
- OAuth Worker 和许可证清单通过官方脚本重新生成；`pnpm build:mobile-web` 与 Desktop `build:no-runtime-assets` 成功，网页资源已装配至独立 Worker 仓库。构建保留现有 chunk 大小、无效动态导入及 Vite config 提示，没有将这些警告写成失败。
- 先前发布的 v3.19.3 基于 `110e84e0`，不包含本节修复；本轮没有改写已发布 tag 或替换安装包。

### 此前代理选择验收记录

- Windows / Node 24.21.0：22 项后端与单元回归通过；使用真实本机 HTTP、HTTPS、SOCKS5 代理按所选 ID 完成 SSH 认证与命令，并验证配置更新、已删除 ID 拒绝、连接池隔离、历史及 schema 保留 ID。
- 14 项浏览器回归通过：1280px / 390px、中英文、明暗主题、键盘选择、代理切换、删除条目、空库、加载失败重试及原 SSH / WSL / Docker 取消和迟到结果。测试将页面绑定远端 ServiceProvider，确认代理列表仍来自本机基础服务。
- `pnpm typecheck`、`pnpm lint`、30 个相关文件的格式检查通过；架构检查 baseline / new / total 均为 0，功能图 YAML、ID、关系端点及源码种子检查通过。
- 本次选择修订涉及 UI、shared 和 desktop，沿用现有 server / provider-node 隧道实现。代理配置所有者仍是本机设置服务，草稿由表单唯一持有，事件顺序见上图；未引入第二份配置或改变 attachment 交付语义。
- 已目视检查窄屏中文截图。本轮完成源码与隔离测试，尚未构建或替换安装包。
