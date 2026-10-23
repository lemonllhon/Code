import type { KnipConfig } from "knip";
import { fileURLToPath } from "node:url";
import { discoverHtmlEntries } from "./scripts/knip-html-entries.mjs";

const webEntries = await discoverHtmlEntries(
  fileURLToPath(new URL("./packages/web/", import.meta.url)),
  ["test/fixtures"],
);

const config: KnipConfig = {
  tags: ["-lintignore"],
  workspaces: {
    ".": {
      // Vite 根别名/CSS、release-it 插件、peer 契约、macOS SEA，以及发行包外部 require。
      ignoreDependencies: [
        "d3-path",
        "tailwind-scrollbar-hide",
        "@release-it/conventional-changelog",
        "@tanstack/react-virtual",
        "postject",
        "node-pty",
      ],
      entry: [
        ".release-it.mjs",
        ".vscode/*.mjs",
        "scripts/check-workspace-freshness.mjs",
        "scripts/mise-run.mjs",
        // 手动回归/维护命令和被 spawn/copy 的入口；依据见 specs/knip-remaining-audit.md。
        "scripts/bench-model-stream-tool-pipeline.mjs",
        "scripts/bench-tool-scheduling.mjs",
        "scripts/benchmark-memory-corpus.mts",
        "scripts/benchmark-memory-evidence.mts",
        "scripts/build-memory-regression.mjs",
        "scripts/compile-desktop-agent-bytecode.cjs",
        "scripts/lcode-distribution-smoke.mjs",
        "scripts/licenses.mjs",
        "scripts/runtime-development-env.d.mts",
        "scripts/sidebar-collaboration-ssh-acceptance.ts",
        "scripts/sync-auth-plugin-vendor.mjs",
        "scripts/verify-agent-memory-and-composer-predictions.mjs",
        "scripts/dev/lcode-stdio-tap.mjs",
        "scripts/lcode-distribution/runner.mjs",
      ],
    },
    "packages/desktop": {
      entry: [
        "electron-builder.config.js",
        // HTML link 引入的启动页样式；JS 入口已由 Vite 插件识别。
        "src/renderer/src/startup/startup.css",
        "src/renderer/cuaPermissionPanel.ts",
        "src/renderer/src/resource-manager.tsx",
        "src/shared/armsRumShared.ts",
        "scripts/startup-settings.fixture.tsx",
        "scripts/startup-welcome.fixture.tsx",
        "scripts/agent-memory-provider.fixture.mjs",
        "scripts/benchmark-diff-idle.mjs",
        "scripts/desktop-product-identity.d.mts",
        "scripts/import-startup-media.mjs",
        "scripts/powershell-command.d.mts",
        "scripts/startup-media-assets.d.mts",
        "scripts/target-platform.d.mts",
        "scripts/write-dev-ready-marker.mjs",
      ],
      // Electron 的虚拟模块与系统命令不由 npm 提供。
      // 外置运行时闭包、按平台选择的 PTY、原生重建命令和覆盖率/CSS 编译。
      ignoreDependencies: [
        "original-fs",
        "@babel/runtime",
        "@lcode/provider",
        "@lydell/node-pty-linux-arm64",
        "@lydell/node-pty-linux-x64",
        "module-details-from-path",
        "yauzl",
        "@electron/rebuild",
        "istanbul-lib-instrument",
        "tailwindcss",
      ],
      ignoreBinaries: ["lipo", "reg.exe"],
    },
    "packages/server": {
      entry: ["src/entry-stdio.ts"],
      // tsup 外置的运行时闭包以及远端各平台 PTY 预编译包，不能用当前平台 import 判断。
      ignoreDependencies: [
        "@lydell/node-pty-darwin-arm64",
        "@lydell/node-pty-darwin-x64",
        "@lydell/node-pty-linux-arm64",
        "@lydell/node-pty-linux-x64",
        "axios",
        "combined-stream",
        "follow-redirects",
        "form-data",
        "node-forge",
        "node-pty",
        "proxy-from-env",
        "undici",
        "yaml",
        "yauzl",
        "yazl",
      ],
    },
    // 架构工具按约定读取这些契约与示例，不通过普通 import 启动。
    "packages/services": { entry: ["src/**/module.ts", "src/**/contract.example.ts"] },
    // Node 的 TSX 单测由 --import tsx 执行，不能按普通产品组件判定为孤立代码。
    "packages/ui": {
      entry: ["src/**/*.test.tsx", "src/hooks/useWorkspaceTaskLists.ts"],
      // 现有 components ignore 不代表可删除它实际 import 的组件库依赖。
      ignoreDependencies: [
        "@rive-app/react-webgl2",
        "@xyflow/react",
        "ansi-to-react",
        "use-stick-to-bottom",
      ],
    },
    "packages/web": {
      entry: [...webEntries, "src/remote/rootRecoveryEntry.ts"],
      ignoreDependencies: ["tailwindcss"],
    },
    "packages/provider-node": {
      entry: ["src/provider-auth/plugins/worker.mjs", "src/network.example.ts"],
    },
    "packages/lcode-server-cli": { entry: ["scripts/verify-remote-ssh.mjs"] },
    "packages/provider": {
      entry: ["src/rate-limit.example.ts", "src/routing/contract.example.ts"],
    },
    "packages/lcode-cua": {
      // JS 模块的 TS 类型解析面，以及 Helper staging 动态复制的原生加载边界。
      entry: [
        "cua-driver.d.ts",
        "installed-app-launcher.d.ts",
        "motion-profile.d.ts",
        "png.d.ts",
        "runtime.d.ts",
        "xa11y-producer.d.ts",
        "xa11y-native-loader.js",
      ],
    },
    "apps/lcode-cli": {
      entry: ["scripts/shadow-replay.mjs"],
      // 共享构建/检查命令、SEA 注入和保留 source map 的手动覆盖率入口。
      ignoreDependencies: ["c8", "esbuild", "oxlint", "postject"],
    },
    "apps/lcode-cli/packages/adapters": { entry: ["src/model/api-key-oauth-sdk.fixture.ts"] },
    "apps/lcode-cli/packages/core": { entry: ["scripts/export-request-context-quality.ts"] },
    "apps/lcode-cli/packages/bootstrap": {
      entry: [
        "scripts/workflow-host-agent.fixture.ts",
        "scripts/benchmarks/request-context-quality/run.ts",
        "scripts/benchmarks/workflow-efficiency/launch.mjs",
        "scripts/benchmarks/workflow-stress/run.ts",
        "scripts/benchmarks/workflow-stress/measurement-correction.ts",
      ],
    },
    "apps/lcode-cli/packages/dynamic-workflow": { entry: ["scratch/run.mjs"] },
    "apps/lcode-cli/packages/debug": { entry: ["src/**/*.test.tsx"] },
    "apps/lcode-cli/packages/node-repl-host": {
      // tsconfig 的声明输出是构建产物，项目扫描只针对源码与测试。
      project: ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}", "!dist-types/**"],
    },
    "apps/lcode-cli/packages/browser-use-plugin": { entry: ["src/browser-client.ts"] },
  },
  ignoreBinaries: ["volta", "plutil"],
  ignore: [".agents/**", "packages/ui/src/components/**"],
};

export default config;
