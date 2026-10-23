/* eslint-disable max-lines -- 编辑器检测需要集中维护跨平台路径、图标解析和缓存逻辑。 */
/**
 * 编辑器检测与打开 —— 检测系统中已安装的编辑器/终端，获取图标，打开路径
 *
 * 当前支持 macOS / Windows。Linux 后续再补。
 */

import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, win32 as pathWin32 } from "node:path";
import { app, nativeImage } from "electron";
import type { EditorInfo } from "@lcode/shared";
import { getLCodeDataRootDir } from "@lcode/services/desktop-main";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);
const WINDOWS_EXPLORER_PATH = pathWin32.join(process.env.WINDIR ?? "C:/Windows", "explorer.exe");

interface EditorDef {
  id: string;
  name: string;
  /** macOS .app bundle 路径 */
  appPath: string;
  appPathCandidates?: string[];
  windowsCommandAppNames?: string[];
  /** CLI 命令名（如果有）。用于 open folder；null 则 fallback 到 `open -a` */
  command: string | null;
}

interface AppBundleInfoPlist {
  CFBundleIconFile?: string;
  CFBundleIconFiles?: string[];
  CFBundleIconName?: string;
  CFBundleIcons?: {
    CFBundlePrimaryIcon?: {
      CFBundleIconFiles?: string[];
      CFBundleIconName?: string;
    };
  };
}

interface ResolvedAppIconPath {
  candidateIconNames: string[];
  path: string | null;
  reason: "resolved" | "missing-plist" | "missing-icon-name" | "missing-icon-file";
}

interface ParsedIcnsPngCandidate {
  osType: string;
  size: number;
  image: Buffer;
}

const MAC_EDITOR_DEFS: EditorDef[] = [
  // 代码编辑器
  {
    id: "vscode",
    name: "VS Code",
    appPath: "/Applications/Visual Studio Code.app",
    command: "code",
  },
  // 这里之前只登记了稳定版 VS Code，`getInstalledEditors()` 又完全依赖这份静态白名单做 existsSync 过滤。
  // 用户安装的是 `Visual Studio Code - Insiders.app` 时，主进程根本不会把它纳入候选列表，UI 自然也就显示不出来。
  // 补上独立定义后，既能识别 Insiders，也能复用现有的 `code-insiders` CLI / `open -a` 降级打开链路。
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    appPath: "/Applications/Visual Studio Code - Insiders.app",
    command: "code-insiders",
  },
  { id: "cursor", name: "Cursor", appPath: "/Applications/Cursor.app", command: "cursor" },
  { id: "trae", name: "Trae", appPath: "/Applications/Trae.app", command: null },
  { id: "zed", name: "Zed", appPath: "/Applications/Zed.app", command: "zed" },
  {
    id: "sublime",
    name: "Sublime Text",
    appPath: "/Applications/Sublime Text.app",
    command: "subl",
  },
  { id: "codebuddy", name: "CodeBuddy", appPath: "/Applications/CodeBuddy.app", command: null },
  { id: "qoder", name: "Qoder", appPath: "/Applications/Qoder.app", command: null },
  // JetBrains 系列
  {
    id: "idea",
    name: "IntelliJ IDEA",
    appPath: "/Applications/IntelliJ IDEA.app",
    command: "idea",
  },
  {
    id: "idea-ce",
    name: "IntelliJ IDEA CE",
    appPath: "/Applications/IntelliJ IDEA CE.app",
    command: "idea",
  },
  { id: "webstorm", name: "WebStorm", appPath: "/Applications/WebStorm.app", command: "webstorm" },
  { id: "pycharm", name: "PyCharm", appPath: "/Applications/PyCharm.app", command: "pycharm" },
  { id: "goland", name: "GoLand", appPath: "/Applications/GoLand.app", command: "goland" },
  { id: "phpstorm", name: "PhpStorm", appPath: "/Applications/PhpStorm.app", command: "phpstorm" },
  { id: "rider", name: "Rider", appPath: "/Applications/Rider.app", command: "rider" },
  { id: "clion", name: "CLion", appPath: "/Applications/CLion.app", command: "clion" },
  { id: "rubymine", name: "RubyMine", appPath: "/Applications/RubyMine.app", command: "rubymine" },
  { id: "datagrip", name: "DataGrip", appPath: "/Applications/DataGrip.app", command: "datagrip" },
  // 终端（macOS 新版系统 Terminal 在 /System/Applications 下）
  {
    id: "terminal",
    name: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    command: null,
  },
  { id: "iterm2", name: "iTerm", appPath: "/Applications/iTerm.app", command: null },
  { id: "ghostty", name: "Ghostty", appPath: "/Applications/Ghostty.app", command: null },
  { id: "warp", name: "Warp", appPath: "/Applications/Warp.app", command: null },
  // 文件管理器
  {
    id: "finder",
    name: "Finder",
    appPath: "/System/Library/CoreServices/Finder.app",
    command: null,
  },
  // 功能扩展：QSpace / QSpace Pro 是 macOS 第三方文件管理器，默认没有 CLI，复用 open -a app bundle 打开路径。
  {
    id: "qspace",
    name: "QSpace",
    appPath: "/Applications/QSpace.app",
    command: null,
  },
  {
    id: "qspace-pro",
    name: "QSpace Pro",
    appPath: "/Applications/QSpace Pro.app",
    command: null,
  },
];

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0),
    ),
  );
}

function getWindowsProgramFilesRoots(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  return uniquePaths([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ]);
}

function getWindowsLocalProgramsRoot(): string {
  const systemDrive = process.env.SystemDrive || "C:";
  return pathWin32.join(
    process.env.LOCALAPPDATA || `${systemDrive}\\Users\\Default\\AppData\\Local`,
    "Programs",
  );
}

function windowsLocalProgramCandidate(...segments: string[]): string {
  return pathWin32.join(getWindowsLocalProgramsRoot(), ...segments);
}

function windowsProgramFilesCandidates(...segments: string[]): string[] {
  return getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, ...segments));
}

async function getWindowsJetBrainsEditorDefs(): Promise<EditorDef[]> {
  const roots = uniquePaths([
    ...getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, "JetBrains")),
    pathWin32.join(getWindowsLocalProgramsRoot(), "JetBrains"),
  ]);
  // 原来在模块导入时为每个产品重复同步扫描目录；按需异步读取，每个根只读一次。
  const installedDirectories = await Promise.all(
    roots.map(async (root) => {
      try {
        const entries = await readdir(root, { withFileTypes: true });
        return {
          root,
          names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        };
      } catch {
        // JetBrains products are optional; missing roots are expected.
        return { root, names: [] as string[] };
      }
    }),
  );
  return (
    [
      ["idea", "IntelliJ IDEA", "idea64.exe"],
      ["webstorm", "WebStorm", "webstorm64.exe"],
      ["pycharm", "PyCharm", "pycharm64.exe"],
      ["goland", "GoLand", "goland64.exe"],
      ["clion", "CLion", "clion64.exe"],
    ] as const
  ).map(([id, name, executable]) =>
    createWindowsEditorDef(
      id,
      name,
      installedDirectories.flatMap(({ root, names }) =>
        names
          .filter((entry) => entry.toLowerCase().startsWith(name.toLowerCase()))
          .sort((left, right) => right.localeCompare(left))
          .map((entry) => pathWin32.join(root, entry, "bin", executable)),
      ),
    ),
  );
}

function createWindowsEditorDef(
  id: string,
  name: string,
  appPathCandidates: string[],
  command: string | null = null,
  windowsCommandAppNames: string[] = [],
): EditorDef {
  const candidates = uniquePaths(appPathCandidates);
  return {
    id,
    name,
    appPath: candidates[0] ?? "",
    appPathCandidates: candidates.slice(1),
    windowsCommandAppNames,
    command,
  };
}

async function filterExistingPaths(paths: string[]): Promise<string[]> {
  const exists = await Promise.all(
    paths.map(async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    }),
  );
  return paths.filter((_path, index) => exists[index]);
}

async function resolveWindowsCommandPaths(command: string): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    // where 的超时原来同步阻塞 Main；保留探测预算，但让窗口消息循环继续运行。
    const { stdout } = await execFileAsync("where.exe", [command], {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    return filterExistingPaths(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return [];
  }
}

async function deriveWindowsAppPathsFromCommand(
  command: string,
  appNames: string[],
): Promise<string[]> {
  const candidates: string[] = [];

  for (const commandPath of await resolveWindowsCommandPaths(command)) {
    const commandDir = pathWin32.dirname(commandPath);
    for (const appRoot of uniquePaths([commandDir, pathWin32.dirname(commandDir)])) {
      for (const appName of appNames) {
        candidates.push(pathWin32.join(appRoot, appName));
      }
    }
  }

  // Windows PATH 常见的是 bin\code.cmd 这类 shim，真实 exe 才能提供和 mac 一致的应用图标。
  return filterExistingPaths(uniquePaths(candidates));
}

const WINDOWS_EDITOR_DEFS: EditorDef[] = [
  // Workspace 顶部“Open in Editor”以前只把真正的 IDE 暴露给 UI，
  // Windows 用户缺少最基础的“在资源管理器里打开”入口，只能回到其它菜单操作。
  // 这里把系统文件管理器也作为 editor 列表的一员，让 macOS Finder / Windows 资源管理器体验对齐。
  { id: "explorer", name: "资源管理器", appPath: WINDOWS_EXPLORER_PATH, command: null },
];

const WINDOWS_ADDITIONAL_EDITOR_DEFS: EditorDef[] = [
  createWindowsEditorDef(
    "vscode",
    "VS Code",
    [
      windowsLocalProgramCandidate("Microsoft VS Code", "Code.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code", "Code.exe"),
    ],
    "code",
    ["Code.exe"],
  ),
  createWindowsEditorDef(
    "vscode-insiders",
    "VS Code Insiders",
    [
      windowsLocalProgramCandidate("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code Insiders", "Code - Insiders.exe"),
    ],
    "code-insiders",
    ["Code - Insiders.exe"],
  ),
  createWindowsEditorDef(
    "cursor",
    "Cursor",
    [
      windowsLocalProgramCandidate("Cursor", "Cursor.exe"),
      ...windowsProgramFilesCandidates("Cursor", "Cursor.exe"),
    ],
    "cursor",
    ["Cursor.exe"],
  ),
  createWindowsEditorDef("trae", "Trae", [
    windowsLocalProgramCandidate("Trae", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae CN.exe"),
    ...windowsProgramFilesCandidates("Trae", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae CN.exe"),
  ]),
];

export async function getEditorDefsForCurrentPlatform(): Promise<EditorDef[]> {
  if (process.platform === "darwin") {
    return MAC_EDITOR_DEFS;
  }

  if (process.platform === "win32") {
    return [
      ...WINDOWS_EDITOR_DEFS,
      ...WINDOWS_ADDITIONAL_EDITOR_DEFS,
      ...(await getWindowsJetBrainsEditorDefs()),
    ];
  }

  return [];
}

export async function resolveEditorDefAppPath(def: EditorDef): Promise<string | null> {
  const fixedPaths = await filterExistingPaths(
    uniquePaths([def.appPath, ...(def.appPathCandidates ?? [])]),
  );
  // 固定路径本就优先；先确认它们，避免已安装应用仍为 PATH 扫描等待系统命令。
  const fixedPath = fixedPaths[0];
  if (fixedPath !== undefined) return fixedPath;
  const commandAppPaths =
    def.command && def.windowsCommandAppNames?.length
      ? await deriveWindowsAppPathsFromCommand(def.command, def.windowsCommandAppNames)
      : [];
  const commandPaths =
    process.platform === "win32" && def.windowsCommandAppNames?.length
      ? []
      : def.command
        ? await resolveWindowsCommandPaths(def.command)
        : [];
  return (await filterExistingPaths(uniquePaths([...commandAppPaths, ...commandPaths])))[0] ?? null;
}

let cachedEditors: EditorInfo[] | null = null;
let editorsInFlight: Promise<EditorInfo[]> | null = null;
let cachedIcnsModule: Promise<typeof import("@fiahfy/icns") | null> | undefined;

function getIcnsModule(): Promise<typeof import("@fiahfy/icns") | null> {
  cachedIcnsModule ??= import("@fiahfy/icns").catch((error: unknown) => {
    // 这里之前在模块顶层直接 require("@fiahfy/icns")。
    // 一旦安装包漏掉它的子依赖（这次是 pngjs），主进程会在文件加载阶段直接崩溃，
    // 连后面的 sips / file icon 降级路径都来不及执行。改成按需懒加载后，缺包时只降级图标解析。
    logger.warn("[editors] 加载 @fiahfy/icns 失败，图标解析将回退到 sips", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  return cachedIcnsModule;
}

async function readAppBundleInfoPlist(appPath: string): Promise<AppBundleInfoPlist | null> {
  try {
    const infoPlistPath = join(appPath, "Contents", "Info.plist");
    const { stdout } = await execFileAsync(
      "plutil",
      ["-convert", "json", "-o", "-", infoPlistPath],
      {
        encoding: "utf8",
        timeout: 3000,
      },
    );
    return JSON.parse(stdout) as AppBundleInfoPlist;
  } catch (error) {
    logger.warn("[editors] 读取 Info.plist 失败，图标将回退到 file icon", {
      appPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveAppIconPath(appPath: string): Promise<ResolvedAppIconPath> {
  const plist = await readAppBundleInfoPlist(appPath);
  if (!plist) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-plist",
    };
  }

  // `defaults read` 对不少第三方 .app 读不到 CFBundleIconFile，
  // 会让所有编辑器误回退到 Electron 的通用文件图标；这里改为直接解析 Info.plist。
  const iconNames = [
    plist.CFBundleIconFile,
    ...(plist.CFBundleIconFiles ?? []),
    ...(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ?? []),
    plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
    plist.CFBundleIconName,
  ].filter(
    (iconName): iconName is string => typeof iconName === "string" && iconName.trim().length > 0,
  );

  if (iconNames.length === 0) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-icon-name",
    };
  }

  for (const iconName of iconNames) {
    const candidateFileNames = iconName.endsWith(".icns")
      ? [iconName]
      : [iconName, `${iconName}.icns`];

    for (const candidateFileName of candidateFileNames) {
      const candidatePath = join(appPath, "Contents", "Resources", candidateFileName);
      // Ghostty 这类应用会同时存在同名资源目录和真正的 .icns 文件。
      // 之前这里只判断 existsSync，先命中目录后就会把目录当成图标文件读，
      // 最终解析失败并退回成发白的系统 file icon。这里要求候选路径必须是文件。
      const candidateStats = await stat(candidatePath).catch(() => null);
      if (candidateStats?.isFile()) {
        return {
          candidateIconNames: iconNames,
          path: candidatePath,
          reason: "resolved",
        };
      }
    }
  }

  return {
    candidateIconNames: iconNames,
    path: null,
    reason: "missing-icon-file",
  };
}

async function loadNativeImageFromIcnsViaPackage(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Promise<Electron.NativeImage | null> {
  const icnsModule = await getIcnsModule();
  if (!icnsModule) {
    return null;
  }

  const { Icns } = icnsModule;

  try {
    const icnsBuffer = await readFile(icnsPath);
    const icns = Icns.from(icnsBuffer);
    const pngCandidates = icns.images
      .map((image): ParsedIcnsPngCandidate | null => {
        const supportedIconType = Icns.supportedIconTypes.find(
          (iconType) => iconType.osType === image.osType,
        );
        if (!supportedIconType || supportedIconType.format !== "PNG") {
          return null;
        }
        return {
          osType: image.osType,
          size: supportedIconType.size,
          image: image.image,
        };
      })
      .filter((candidate): candidate is ParsedIcnsPngCandidate => candidate !== null)
      .sort((left, right) => right.size - left.size);

    if (pngCandidates.length === 0) {
      logger.info("[editors] @fiahfy/icns 未解析到 PNG icon，图标将回退到 sips", {
        editorId,
        appPath,
        icnsPath,
        availableIconTypes: icns.images.map((image) => image.osType),
      });
      return null;
    }

    for (const candidate of pngCandidates) {
      const icon = nativeImage.createFromBuffer(candidate.image);
      if (!icon.isEmpty()) {
        return icon;
      }
    }

    logger.warn("[editors] @fiahfy/icns 已解析到 PNG icon，但 nativeImage 仍为空", {
      editorId,
      appPath,
      icnsPath,
      pngCandidateTypes: pngCandidates.map((candidate) => `${candidate.osType}:${candidate.size}`),
    });
    return null;
  } catch (error) {
    logger.warn("[editors] @fiahfy/icns 解析失败，图标将回退到 sips", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function loadNativeImageFromIcnsViaSips(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Promise<Electron.NativeImage | null> {
  const tempRootDir = join(getLCodeDataRootDir(), "editor-icon");
  let tempDirPath: string | undefined;

  try {
    // 创建临时目录也属于可失败的图标转换；失败时仍走原 native icon fallback。
    await mkdir(tempRootDir, { recursive: true });
    tempDirPath = await mkdtemp(join(tempRootDir, "icon-"));
    const tempPngPath = join(tempDirPath, "icon.png");
    await execFileAsync("sips", ["-s", "format", "png", icnsPath, "--out", tempPngPath], {
      encoding: "utf8",
      timeout: 5000,
    });
    const pngBuffer = await readFile(tempPngPath);
    const icon = nativeImage.createFromBuffer(pngBuffer);
    if (icon.isEmpty()) {
      logger.warn("[editors] sips 已输出 PNG，但 nativeImage 仍为空", {
        editorId,
        appPath,
        icnsPath,
        tempPngPath,
      });
      return null;
    }
    return icon;
  } catch (error) {
    logger.warn("[editors] .icns 转 PNG 失败，图标将回退到 file icon", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    try {
      if (tempDirPath) await rm(tempDirPath, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响图标加载
    }
  }
}

async function loadNativeImageFromIcns(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Promise<Electron.NativeImage | null> {
  // Electron 的 nativeImage 不适合直接读取 .icns，
  // 这里优先用 npm 包解析出 PNG icon，减少每个图标都起系统子进程的成本；
  // 只有遇到老格式或包解析不到的 case，才回退到 macOS 的 sips。
  return (
    (await loadNativeImageFromIcnsViaPackage(editorId, appPath, icnsPath)) ??
    (await loadNativeImageFromIcnsViaSips(editorId, appPath, icnsPath))
  );
}

/**
 * 从 .app bundle 的 Info.plist 读取多个可能的 icon 字段，
 * 然后把 .icns 转成 PNG，再生成可用于菜单的真实图标。
 * 如果解析不到真实图标，再 fallback 到 Electron 的 app.getFileIcon。
 */
export async function getAppIconDataUrl(editorId: string, appPath: string): Promise<string | null> {
  if (process.platform !== "darwin") {
    return app
      .getFileIcon(appPath, { size: "normal" })
      .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
      .catch((error) => {
        logger.warn("[editors] 获取 file icon 失败", {
          editorId,
          appPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
  }
  // Step 1: 尝试从 .icns 文件加载真实 app 图标
  const resolvedIcon = await resolveAppIconPath(appPath);
  if (resolvedIcon.path) {
    const icon = await loadNativeImageFromIcns(editorId, appPath, resolvedIcon.path);
    if (icon && !icon.isEmpty()) {
      // 缩放到合适大小（32x32 用于菜单显示）
      const resized = icon.resize({ width: 32, height: 32 });
      return Promise.resolve(`data:image/png;base64,${resized.toPNG().toString("base64")}`);
    }
  } else {
    logger.info("[editors] 未解析到真实 app 图标，图标将回退到 file icon", {
      editorId,
      appPath,
      reason: resolvedIcon.reason,
      candidateIconNames: resolvedIcon.candidateIconNames,
    });
  }

  // Step 2: fallback 到 Electron 的 app.getFileIcon
  return app
    .getFileIcon(appPath, { size: "normal" })
    .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
    .catch((error) => {
      logger.warn("[editors] 获取 file icon 失败", {
        editorId,
        appPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
}

/**
 * 检测系统中已安装的编辑器/终端，返回带图标的列表。
 * 结果会被缓存（应用生命周期内不变）。
 */
async function discoverInstalledEditors(): Promise<EditorInfo[]> {
  const startedAt = performance.now();
  const definitions = await getEditorDefsForCurrentPlatform();
  const installed = (
    await Promise.all(
      definitions.map(async (def) => {
        const appPath = await resolveEditorDefAppPath(def);
        return appPath ? { def, appPath } : null;
      }),
    )
  ).filter((entry): entry is { def: EditorDef; appPath: string } => entry !== null);
  const iconsStartedAt = performance.now();
  const results = await Promise.all(
    installed.map(async ({ def, appPath }) => {
      const iconDataUrl = await getAppIconDataUrl(def.id, appPath);
      if (!iconDataUrl) {
        return null;
      }
      return { id: def.id, name: def.name, iconDataUrl };
    }),
  );

  const editors = results.filter((r): r is EditorInfo => r !== null);
  logger.info("[editors] discovery completed", {
    platform: process.platform,
    durationMs: Math.round(performance.now() - startedAt),
    discoveryDurationMs: Math.round(iconsStartedAt - startedAt),
    iconDurationMs: Math.round(performance.now() - iconsStartedAt),
    editorCount: editors.length,
  });
  return editors;
}

export function getInstalledEditors(): Promise<EditorInfo[]> {
  if (cachedEditors !== null) return Promise.resolve(cachedEditors);
  if (editorsInFlight) return editorsInFlight;
  // 之前只缓存完成结果，图标等待期间的请求会重复扫描并放大 Main 阻塞。
  // 同批请求共享 flight；失败也清除，下一次真实需求才能重新发现。
  const flight = discoverInstalledEditors()
    .then((editors) => {
      cachedEditors = editors;
      return editors;
    })
    .finally(() => {
      if (editorsInFlight === flight) editorsInFlight = null;
    });
  editorsInFlight = flight;
  return flight;
}
