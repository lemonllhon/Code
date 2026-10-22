import { useEffect, useState, useRef } from "react";
import type { IServiceAccessor } from "@lcode/services";
import type { FileEntry } from "@lcode/shared";
import {
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Eye,
  EyeOff,
  FolderIcon,
  FolderSymlinkIcon,
  HardDrive,
  House,
  Search,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./components/ui/input-group.js";
import { useLCodeIntl } from "./i18n/IntlProvider.js";
import { logger } from "./logger.js";
import { getContainingDirectoryPath, isAbsoluteFilePath, joinFilePath } from "./lib/path.js";

function isDirectoryPathInput(value: string): boolean {
  return (
    isAbsoluteFilePath(value) ||
    value === "~" ||
    /^~[\\/]/.test(value) ||
    /^\.{1,2}(?:[\\/]|$)/.test(value)
  );
}

function getDirectoryRoot(path: string): string {
  const root = path.match(/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$)|\/)/)?.[0] || "/";
  return root.startsWith("\\\\") && !root.endsWith("\\") ? `${root}\\` : root;
}

function createDirectoryBrowserReadParams(
  path: string,
  showHiddenDirectories: boolean,
): { path: string; includeHidden?: boolean } {
  return showHiddenDirectories ? { path, includeHidden: true } : { path };
}

function filterDirectoryBrowserEntries(entries: FileEntry[]): FileEntry[] {
  return entries.filter((e) => e.type === "directory");
}

// 远程目录条目已经携带 isSymbolicLink，这里只替换展示图标，不改变进入和选择目录的路径语义。
function getDirectoryBrowserEntryIconKind(
  entry: Pick<FileEntry, "isSymbolicLink" | "type">,
): "folder" | "folder-symlink" {
  return entry.type === "directory" && entry.isSymbolicLink === true ? "folder-symlink" : "folder";
}

function createDirectoryBrowserRequestGuard(): {
  begin: () => number;
  isCurrent: (requestId: number) => boolean;
} {
  let latestRequestId = 0;

  return {
    begin: () => {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent: (requestId: number) => requestId === latestRequestId,
  };
}

/**
 * 服务端目录浏览对话框。
 * 通过 fileService.readdir 浏览远程/本地服务器的目录结构，
 * 适用于 web 端无法调用系统原生文件选择器的场景。
 */
export function DirectoryBrowser({
  services,
  onSelect,
  onCancel,
  onPathChange,
  onReadyChange,
  embedded = false,
}: {
  services: IServiceAccessor;
  onSelect: (path: string) => void;
  onCancel: () => void;
  onPathChange?: (path: string) => void;
  onReadyChange?: (ready: boolean) => void;
  embedded?: boolean;
}) {
  const [currentPath, setCurrentPath] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false);
  const [homePath, setHomePath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const showHiddenDirectoriesRef = useRef(false);
  const requestGuardRef = useRef(createDirectoryBrowserRequestGuard());
  const { intl } = useLCodeIntl();
  const rootPath = getDirectoryRoot(currentPath || homePath);
  const parentPath =
    currentPath.replace(/[\\/]+$/, "") === rootPath.replace(/[\\/]+$/, "")
      ? null
      : getContainingDirectoryPath(currentPath);
  const trimmedInput = inputValue.trim();
  // 路径和筛选共用一个草稿，按明确的路径前缀派生模式，避免两份输入状态互相覆盖。
  const isPathInput = isDirectoryPathInput(trimmedInput);
  const normalizedFilter = isPathInput ? "" : trimmedInput.toLocaleLowerCase();
  const visibleEntries = entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(normalizedFilter),
  );
  const isReadyForInput = (value: string) =>
    Boolean(currentPath) &&
    !loading &&
    !error &&
    (!isDirectoryPathInput(value.trim()) || value.trim() === currentPath);
  const ready = isReadyForInput(inputValue);

  // 初始化：获取 homedir 作为起始路径
  useEffect(() => {
    let active = true;
    services.systemService
      .info()
      .then((info) => {
        if (active) {
          setHomePath(info.homedir);
          void navigateTo(info.homedir);
        }
      })
      .catch((err) => {
        if (!active) return;
        logger.error("[DirectoryBrowser] 获取系统信息失败:", err);
        setError(intl.formatMessage({ id: "directoryBrowser.errorSystem" }));
        setLoading(false);
      });
    return () => {
      active = false;
      requestGuardRef.current.begin();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateTo = async (
    path: string,
    nextShowHiddenDirectories = showHiddenDirectoriesRef.current,
  ) => {
    const requestId = requestGuardRef.current.begin();
    // 导航期间原目录不再是可确认目标；失败或旧响应不能让外层提交旧路径。
    onReadyChange?.(false);
    setLoading(true);
    setError("");
    try {
      const result = await services.fileService.readdir(
        createDirectoryBrowserReadParams(path, nextShowHiddenDirectories),
      );
      if (!requestGuardRef.current.isCurrent(requestId)) {
        return;
      }
      const dirs = filterDirectoryBrowserEntries(result);
      setEntries(dirs);
      setCurrentPath(path);
      setInputValue(path);
      onPathChange?.(path);
      onReadyChange?.(true);
      // 滚动到顶部
      listRef.current?.scrollTo(0, 0);
    } catch (err) {
      if (!requestGuardRef.current.isCurrent(requestId)) {
        return;
      }
      // 用户快速切换目录或隐藏目录时，较早 readdir 可能后返回；
      // 过期错误不能覆盖最新导航状态，否则 UI 会展示和当前按钮状态不一致的目录/错误。
      logger.error("[DirectoryBrowser] readdir 失败:", err);
      setError(intl.formatMessage({ id: "directoryBrowser.errorReadDir" }, { error: String(err) }));
    } finally {
      if (requestGuardRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  };

  const handleGoUp = () => {
    // 目标设备可能是 Windows；复用跨平台路径工具，盘符根和 UNC share 根不可继续向上。
    if (parentPath) void navigateTo(parentPath);
  };

  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 名称输入只筛选已读列表；回车不能把筛选词作为远端进程的相对路径读取。
    if (!isPathInput) return;
    const target =
      trimmedInput === "~"
        ? homePath
        : /^~[\\/]/.test(trimmedInput)
          ? joinFilePath(homePath, trimmedInput.slice(2))
          : isAbsoluteFilePath(trimmedInput)
            ? trimmedInput
            : joinFilePath(currentPath, trimmedInput);
    void navigateTo(target);
  };

  const handleToggleHiddenDirectories = () => {
    const nextShowHiddenDirectories = !showHiddenDirectoriesRef.current;
    showHiddenDirectoriesRef.current = nextShowHiddenDirectories;
    setShowHiddenDirectories(nextShowHiddenDirectories);

    if (currentPath) {
      void navigateTo(currentPath, nextShowHiddenDirectories);
    }
  };

  const handleSelectCurrentPath = () => {
    const selectedPath = currentPath.trim();
    if (!ready) {
      return;
    }

    onSelect(selectedPath);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  const browserContent = (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="directory-browser">
      <div className="shrink-0 space-y-2">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!parentPath}
            title={intl.formatMessage({ id: "directoryBrowser.parent" })}
            aria-label={intl.formatMessage({ id: "directoryBrowser.parent" })}
            onClick={handleGoUp}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!homePath}
            onClick={() => void navigateTo(homePath)}
          >
            <House className="size-4 text-foreground-subtle" />
            {intl.formatMessage({ id: "directoryBrowser.home" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!homePath}
            onClick={() => void navigateTo(rootPath)}
          >
            <HardDrive className="size-4 text-foreground-subtle" />
            {intl.formatMessage({ id: "directoryBrowser.root" })}
          </Button>
          <Button
            type="button"
            variant={showHiddenDirectories ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={showHiddenDirectories}
            className="ml-auto"
            onClick={handleToggleHiddenDirectories}
          >
            {showHiddenDirectories ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            {intl.formatMessage({
              id: showHiddenDirectories
                ? "directoryBrowser.hideHidden"
                : "directoryBrowser.showHidden",
            })}
          </Button>
        </div>
        {/* 单行地址栏同时承载路径跳转和名称筛选，把浏览空间还给目录列表。 */}
        <form onSubmit={handleInputSubmit}>
          <InputGroup data-testid="directory-browser-input" className="min-h-9 rounded-lg">
            <InputGroupAddon className="py-0 text-foreground-subtle">
              {isPathInput ? <FolderIcon className="size-4" /> : <Search className="size-4" />}
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              data-testid="directory-browser-path"
              type="text"
              size="lg"
              value={inputValue}
              aria-label={intl.formatMessage({ id: "directoryBrowser.pathLabel" })}
              onChange={(e) => {
                setInputValue(e.target.value);
                // 未提交的输入不是已浏览目录，不能让外层确认按钮沿用旧路径。
                onReadyChange?.(isReadyForInput(e.target.value));
              }}
              onFocus={(event) => {
                if (isPathInput) event.currentTarget.select();
              }}
              title={intl.formatMessage({ id: "directoryBrowser.inputHelp" })}
              placeholder={intl.formatMessage({
                id: "directoryBrowser.pathPlaceholder",
              })}
              className={`min-h-9 min-w-0 max-sm:text-mobile-input-safe ${isPathInput ? "font-mono" : ""}`}
              autoFocus
            />
            <InputGroupAddon
              align="inline-end"
              className="shrink-0 gap-1 py-0 text-foreground-subtle"
            >
              <span className="whitespace-nowrap text-ui-sm font-normal">
                {intl.formatMessage(
                  { id: "directoryBrowser.count" },
                  { count: visibleEntries.length },
                )}
              </span>
              {inputValue !== currentPath ? (
                <InputGroupButton
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "directoryBrowser.clearInput" })}
                  title={intl.formatMessage({ id: "directoryBrowser.clearInput" })}
                  onClick={() => {
                    setInputValue(currentPath);
                    onReadyChange?.(isReadyForInput(currentPath));
                    inputRef.current?.focus();
                  }}
                >
                  <X className="size-4" />
                </InputGroupButton>
              ) : null}
              {isPathInput ? (
                <InputGroupButton
                  type="submit"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "directoryBrowser.go" })}
                  title={intl.formatMessage({ id: "directoryBrowser.go" })}
                >
                  <ArrowRight className="size-4" />
                </InputGroupButton>
              ) : null}
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>

      {/* 错误提示 */}
      {error ? (
        <div role="alert" className="shrink-0 text-ui-sm text-destructive">
          {error}
        </div>
      ) : null}

      {/* 目录列表 */}
      <div
        ref={listRef}
        data-testid="directory-browser-list"
        aria-busy={loading}
        className="min-h-16 flex-1 flex flex-col overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface"
      >
        {loading ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : error ? null : visibleEntries.length === 0 ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: normalizedFilter ? "directoryBrowser.noMatches" : "directoryBrowser.noSubdirs",
            })}
          </div>
        ) : (
          visibleEntries.map((entry) => {
            const EntryIcon =
              getDirectoryBrowserEntryIconKind(entry) === "folder-symlink"
                ? FolderSymlinkIcon
                : FolderIcon;

            return (
              <button
                type="button"
                key={entry.path}
                onClick={() => navigateTo(entry.path)}
                className="group flex min-h-9 w-full shrink-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-ui-base transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-input-border-focused"
              >
                <EntryIcon className="size-4 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate" title={entry.name}>
                  {entry.name}
                </span>
                <ChevronRight aria-hidden="true" className="size-3.5 text-foreground-subtlest" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  if (embedded) {
    return browserContent;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={handleKeyDown}
    >
      <div className="flex h-[min(36rem,calc(100vh-4rem))] w-[min(44rem,calc(100vw-2rem))] flex-col rounded-xl border border-border bg-popover p-4 shadow-xl">
        {browserContent}
        {/* 非嵌入模式之前只能继续进入子目录，没有确认当前目录的路径。
            Web 目录浏览器作为独立选择器使用时因此永远拿不到 onSelect 结果。
            这里把确认动作收口到弹窗 footer，选择当前浏览路径并交回上层。 */}
        <div className="mt-3 flex shrink-0 justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-10 min-w-0 px-5 text-ui-base"
            onClick={onCancel}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            size="lg"
            className="h-10 min-w-0 px-5 text-ui-base"
            disabled={!ready}
            onClick={handleSelectCurrentPath}
          >
            {intl.formatMessage({ id: "directoryBrowser.selectDir" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
