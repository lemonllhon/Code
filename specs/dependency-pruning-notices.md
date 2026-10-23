# 依赖清理后的第三方声明同步

## 问题与证据

2026-10-24，Windows 桌面打包在 `generateThirdPartyNotices` 报错
`Stale npm notice override: embla-carousel@8.6.0`。安装图同步后，当前
`pnpm-lock.yaml` 已不包含以下四个精确版本，但 `third-party/npm-overrides.json`
仍保留它们的补充登记：

- `embla-carousel@8.6.0`
- `embla-carousel-react@8.6.0`
- `embla-carousel-reactive-utils@8.6.0`
- `boolbase@1.0.0`

这是依赖移除后的登记残留；修复依据是当前锁文件与生成器的生产依赖校验，不能恢复
这些依赖，也不能跳过过期登记检查。

继续生成后确认，`third-party/native-search/sources.json` 的两项输入哈希仍对应
`HEAD` 中的配置。当前 `scripts/native-search-tools-config.mjs` 与
`scripts/remote-native-search-tools-config.mjs` 仅移除了未使用的 `export`；对源码统一
换行并去除导出标记后逐字比较相等，工具版本、URL、归档校验和及构建参数未变。

## 规则与所有者

- `pnpm-lock.yaml` 和 workspace manifest 共同确定当前依赖集合；保留现有生产图与
  实装图一致性检查、缺失依赖检查和过期 override 检查。
- 人工维护的 `third-party/npm-overrides.json` 只移除上述四条已删除依赖的记录。
  原始上游材料继续保留，其他依赖的许可材料与复核结论不变。
- `generateThirdPartyNotices` 继续作为 `THIRD-PARTY-NOTICES.md` 和
  `third-party/inventory.json` 的唯一写入入口，通过 `node scripts/licenses.mjs notices`
  重新生成，不手改派生产物的包列表或哈希。
- `boolbase@1.0.0` 已退出依赖集合，对应材料缺口也退出当前 inventory；本次人工核对
  后仅从 `third-party/release-review-baseline.json` 移除同一条目。其余 19 条材料缺口及其
  理由保持一致；生成器和 CI 不自动刷新发布基线，新增、删减或变更仍须严格匹配。
- 人工核对原生工具配置仅有导出可见性变化后，更新
  `third-party/native-search/sources.json` 中对应的两项输入字节哈希；组件清单、归档、
  校验和、许可文本和材料缺口全部不变。保留原生材料的严格哈希验证。
- 本次只同步根目录构建工具的数据登记和派生产物，不改变产品行为、运行时状态、
  模块接口、依赖方向或任何桌面/手机协议。根工具未纳入受控源码模块。

## 验收

- 生成命令通过，当前所有 override 都能在生产依赖集合中找到，四条过期记录不再出现。
- `readReleaseVerifiedNotices` 验证新声明的字节哈希、输入新鲜度与发布基线成功；
  其余 19 条材料缺口的 ID 和理由保持不变。
- `readNativeSearchNotices` 的 `verify: true` 校验通过，原生登记除两项输入哈希外
  与修改前完全一致。
- 已有许可图、声明写入及发布基线回归通过，包括拒绝未同步的基线删减与新增。
- 执行 `pnpm typecheck`、`pnpm lint` 和架构检查，报告实际结果；桌面 Agent 准备链路
  通过此次失败点。未执行完整安装包构建时明确说明。

## 本次验证结果

- `node scripts/licenses.mjs notices` 成功：生产包版本从 1246 减为 1203，移除 43 个版本，
  无新增版本；保留 20 个复制组件及 18 个原生归档。
- 直接执行 `readReleaseVerifiedNotices` 成功；真实 `prepareDesktopAgentInputs` 在
  `LCODE_ENV=production`、`LCODE_VERIFY_RELEASE_INPUTS=1` 下成功生成 worker 并验证声明。
  66 条剩余 override 与修改前一致；19 条材料缺口的 ID、理由与原基线扣除 boolbase 后一致。
- 36 项定向测试通过：生产依赖图/声明原子写入/workspace 补丁 15 项，桌面 Agent 同步
  7 项，材料策略及发布基线 14 项。最后一组实际执行旧 `check --strict`，整仓检查通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 均通过；架构
  baseline/new/总违规均为 0，修改文件的 `git diff --check` 通过。
- 格式检查仍报告 `npm-overrides.json` 与 `native-search/sources.json` 的原有格式问题，
  修改前的独立备份也失败；保留原格式，未批量重排登记。spec 与发布基线格式检查通过。
- 未重建完整 Windows 安装包；本次验证覆盖原报错的声明生成及桌面 Agent 构建输入阶段。
