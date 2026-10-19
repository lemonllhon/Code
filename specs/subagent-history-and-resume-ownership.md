# 子会话历史读取与恢复所有权

## 产品规则

打开 live/cold subagent_child 或 workflow_child 详情只重建投影，不创建 app/runtime、Browser scope、模型请求或 workflow run。publisher 和历史 metadata 不代表执行权限。根交互会话经原 READY 单飞恢复，候选未就绪时不能接受执行命令。

两类 child 的通用 prompt、排队和续目标入口均只读，在 ledger/输入历史/admission 之前拒绝。workflow supplement、retry、revision、独立 actor continuation 仍通过原 workflow owner。读取附件、文件摘要、预览和已授权回溯保留原入口。

## 所有者与接口

- context.sessions 只发布成功 READY 的可执行根 record；恢复候选由原 flight 持有。失败撤销本代订阅并关闭候选，不覆盖首次异常，不删除并发新代与持久历史。
- context 的 root resume flight 只协调未完成的物化 Promise，成功/失败后清除；与 projection READY 水位分工，不缓存另一份可执行 record。legacy resume 与 V4 共用这个入口，不能并发创建两份同 ID app。
- ProtocolRuntimeResources 保留关闭失败的 app，失败关闭可重试；为同 ID 再构造前先完成该失败资源的清理。只有关闭成功才从资源 owner 删除，不在 finally 无条件删除。该条覆盖本轮实施中新复现的 BR09 关闭句柄丢失。
- child projection 经既有 transcript/entries/journal 三源 merge、sourceEventSeq 和 hydration buffer 形成；不增加第二条历史写入路径。
- 只读 reader 组合现有 SessionStorePort、ToolArtifactStorePort、FileSystemPort/checkpoint；可以借 parent 能力，但读取目标始终是 childSessionId。parent 不活跃时持久读取仍有效，读取失败不能伪装空历史。
- entrypoint 注入只读 artifact/文件端口与模型目录查询；不会创建只读 app。恢复 checkpoint/rewind entry 使用 core 的同一持久 codec，预览使用只依赖读取源的 core 公共接口，实际文件写入仍归现有授权入口。
- 冷子会话的模型身份可来自该会话显式 entry、live ModelSelected 或最后一条真实请求记录，仅用于历史展示和目录容量查询；不能据此执行/绑定模型，不能借父模型填充未知容量。
- 子详情现有 `allowWorkspaceFileRewind` 必须保留：显式文件回溯经原 CommandInbox、canonical row/epoch/revision 校验后调用 core 的同一文件回溯算法，使用明确读写端口和严格持久事件入口，不创建 child app。持久化失败由同一文件 journal 补偿；成功后重建原投影，不能借 publisher 存在放开通用执行输入。
- 文件补偿仅处理严格回执写入边界的结构化失败；普通 runtime 的 appendEvent 可能在事实已提交后的 observer/sink 阶段抛错，这时不能逆转文件造成事实冲突。严格写入 helper 保留原 cause，不能按错误文字识别边界。
- projection-only READY 后将可回收时间登记到 gateway 既有 detachedTerminalAt；没有订阅者、执行 record 和在途命令时按原 grace 回收。收到真实 live child 事件后由原生命周期覆盖该时间，不新增观察缓存或假 live 身份。
- workspaceIdentity 与 remoteSessionId 贯穿校验，不按路径或 session ID 前缀推断权限。模型统计来自 child 的持久绑定/事件，未知保持未知，不为展示绑定模型。
- 只读 workspace 使用现有 `worktree_binding` entry schema 还原执行路径；请求可用执行身份或其 origin 身份进入，但不能换到同路径的另一远程身份。请求的 remoteSessionId 保留在当前 attachment 的投影 seed，不写回持久绑定。
- 普通 Agent child 创建时继承父 runtime 的 `workspacePath`、`workspaceIdentity`（兼容既有 memory identity 来源）、`workspaceBinding` 和 attachment/delivery 字段。`workingDirectory` 仍是本次工具请求的 cwd，不能用它重新生成子会话工作区身份；本地路径表示也不能再次 resolve 后用作身份。
- 历史工作区解析只有一个入口：live record、该会话持久 worktree binding、该会话显式 workspaceID 依次作为事实。只有旧 `subagent_child` 同时缺少 binding 与 workspaceID 时，才沿持久 `parentID` 继承父工作区；父不活跃时读取其持久记录，不靠 sessionId 前缀、UI 请求路径或路径包含关系猜测。缺失父记录时保留原本地 path/directory fallback；读取异常与父链环必须显式失败。
- 借用父 record 的能力前，对父链每一层使用上述同一工作区解析和身份 key 校验。显式跨工作区子会话不能借用父能力；worktree origin 只用于请求入口校验，不替换执行身份。旧记录的兼容仅发生在读取投影，不回写历史、不新建 child runtime、不扩大执行权限。
- 模型目录或历史选模 entry 不可用只影响容量展示，记录诊断并保持未知，不阻断已有正文读取。正文/entry 读取失败则显式失败，不能丢弃 checkpoint 后报恢复成功。
- 本次保持详情完整 transcript 读取语义；现有 bounded snapshot 是搜索用前缀（256 messages / 1,024 parts / 256 KiB），直接替换会截断长详情。因此该端口仍用于原搜索入口，详情的分页原子读取需要另行扩展契约，不能声称本次已实现。

```mermaid
sequenceDiagram
    participant U as 详情/命令入口
    participant O as 原 gateway/READY owner
    participant S as 持久只读端口
    participant R as 根候选 runtime
    U->>O: 读取 metadata 与身份校验
    alt child 详情
        O->>S: 读取 child 历史/附件
        S-->>O: 原 transcript/entries 事实
        O-->>U: Desktop continuous / Mobile replayable 投影
    else 根执行恢复
        O->>R: 初始化与 resume
        alt 失败
            O->>R: 关闭本代，保留重试条件
        else 成功
            O->>O: 发布 READY，再允许 admission
        end
    end
```

```mermaid
sequenceDiagram
    participant P as 父 Runtime（工作区事实 owner）
    participant C as 子 Runtime
    participant S as 原 SessionStore
    participant R as 统一历史工作区解析
    participant V as V4 gateway
    P->>C: 继承工作区/绑定/attachment，单独传执行 cwd
    C->>S: 原子保存 child session + 初始绑定
    C-->>P: SessionReady 后通知 child 可观察
    V->>R: childSessionId + 请求 workspace
    R->>S: 读取 child；旧无身份 child 沿持久 parentID 读取
    R->>R: 校验请求身份、remoteSessionId 与每层父绑定
    R-->>V: 同一执行 workspace 与可信父只读能力
    V-->>V: Desktop continuous / Mobile replayable 各自投影
```

## 验收

1. live/cold child 订阅、重载、重连不新增可执行 record/scope 或模型请求；旧 turn 始终被拒绝。
2. parent active/inactive 均能读取 child 的历史、附件、artifact、文件摘要；message/ref 与 checkpoint 不借错 parent。
3. 根 resume 失败不留下半初始化 record；第二次真实 resume；并发订阅/命令同一 flight，迟到失败不删除新代。
4. 两类 child 的通用执行入口在接受前拒绝；专用 workflow 控制和授权文件回溯继续有效，拒绝保留未提交草稿/附件。
5. continuous 与 replayable 同一事实，不重复提交已接受 busy/running 输入，不添加旧 strict reader 不认识的 wire 字段。
6. 父 cwd 切入子目录、本地入口路径含尾分隔符、显式远程身份与 worktree origin 时，真实 Agent child 持久化仍保留父工作区身份与 binding；attachment/delivery 继续透传。
7. 旧无身份 subagent child 在父 active/inactive、同级及嵌套 parent 链下，continuous/replayable 均可读取与订阅；无需数据迁移或创建 runtime。
8. 借用父能力时 child 显式身份与父身份冲突、请求来自同路径另一 remote identity、attachment 不匹配、父链环、损坏的显式 binding 与读取错误时仍失败；未就绪或历史观察不能变成执行 admission。父记录已缺失时只保留 child 自身本地 path fallback。没有可借用的 live record 时，独立 fork 等会话仍可按自身工作区读取冷历史，不因父工作区不同而阻断。

## 迁移与验证

无数据库迁移，不热修改正在运行的 workflow，不把诊断“缺陷复现通过”当作修复验收。正式结果与未验证范围在执行后记录。

### 2026-10-19 工作区不一致修复

源码复现链路：`createDefaultSubagentPort` 构造 child 时只传执行 cwd，遗漏父 workspacePath/identity/binding；`ensureSessionPersisted` 因此回落到 cwd 保存 path/directory，workspaceID 为空。父 cwd 变为子目录、本地路径表示被规范化、远端身份或 worktree origin 存在时，child 的持久身份与父/UI 请求不再一致。原 `resolveConversationBackingRecord` 又直接用这份 path/identity 比较 live 父，未使用历史读取入口的 binding/origin 解析。

修复保留原持久化 owner 与原子初始 entry 写入，只修正 child 配置派生；历史读取与父能力借用共用工作区解析。旧无身份 subagent 沿持久父关系恢复工作区，既不修库，也不将 UI 请求当作身份来源。

定向验证覆盖真实 Agent 构造和持久化、两种 clientMode 的 gateway 订阅/历史读取、父 active/inactive 与嵌套父链、显式远程身份和 attachment 拒绝、损坏 binding、缺失父记录、父链环、读取异常、跨工作区中间祖先，以及独立 cold fork。日志本身未记录冲突双方的实际 key；没有原机数据库，不能据此声称已逐一还原历史报错会话的具体 cwd。

验证结果：6 个定向测试文件共 33 项通过；根目录 `pnpm typecheck`、`pnpm lint`，以及 `pnpm --dir apps/lcode-cli typecheck`、`pnpm --dir apps/lcode-cli lint` 均通过。`pnpm architecture:check --changed` 为 0 violations / 0 baseline / 0 new；本次 7 个文件的格式检查与 diff whitespace 检查通过。Turbo 仍输出已有的 lockfile workspace 发现警告。未在原 macOS 安装包与原数据库上重放历史会话，未执行桌面 UI E2E。
