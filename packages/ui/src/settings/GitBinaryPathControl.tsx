import { useId, useState } from "react";
import { FileSearch, FolderOpen, RefreshCw } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";

export function GitBinaryPathControl({
  value,
  detectedPath,
  disabled,
  detecting,
  onChange,
  onDetect,
}: {
  value: string;
  detectedPath: string | null;
  disabled: boolean;
  detecting: boolean;
  onChange: (value: string) => void;
  onDetect: () => void;
}) {
  const platform = usePlatform(),
    { intl } = useLCodeIntl(),
    id = useId();
  const t = (key: string) => intl.formatMessage({ id: `settings.gitManagement.${key}` });
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  // 展示检测路径与保存固定路径是两种语义；仅输入时编辑草稿，自动检测不能改成固定配置。
  const displayPath = editing ? value : value || detectedPath || "";
  const separator = Math.max(displayPath.lastIndexOf("/"), displayPath.lastIndexOf("\\"));
  const directory =
    separator === 0
      ? displayPath.slice(0, 1)
      : separator === 2 && /^[a-z]:/i.test(displayPath)
        ? displayPath.slice(0, 3)
        : separator > 0
          ? displayPath.slice(0, separator)
          : "";
  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const selected = await platform.selectFile();
      if (selected) {
        onChange(selected);
        setEditing(false);
      }
    } catch {
      setError("selectGitFailed");
    } finally {
      setBusy(false);
    }
  };
  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      // 现有平台接口会用系统默认程序打开文件；只传父目录，避免“查看位置”启动 git.exe。
      if (!(await platform.openInFileManager(directory)).success) setError("openGitFailed");
    } catch {
      setError("openGitFailed");
    } finally {
      setBusy(false);
    }
  };
  const nativeAvailable = platform.canSelectFilePath === true;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={id} className="flex min-w-0 flex-1 basis-72 flex-col gap-2 text-ui-base">
          <span>{t("binaryPath")}</span>
          <Input
            id={id}
            data-testid="git-binary-path"
            value={displayPath}
            placeholder={detecting ? t("detectingGit") : t("automaticPath")}
            disabled={disabled || busy}
            onChange={(event) => {
              setEditing(true);
              onChange(event.target.value);
            }}
            onBlur={() => setEditing(false)}
          />
        </label>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <Button
            size="icon-sm"
            className="min-h-7"
            variant="outline"
            aria-label={t("selectGitFile")}
            title={t(nativeAvailable ? "selectGitFile" : "nativePathUnavailable")}
            disabled={disabled || busy || !nativeAvailable}
            onClick={() => void choose()}
          >
            <FileSearch className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            className="min-h-7"
            variant="ghost"
            aria-label={t("openGitLocation")}
            title={t(nativeAvailable ? "openGitLocation" : "nativePathUnavailable")}
            disabled={disabled || busy || !nativeAvailable || !directory.trim()}
            onClick={() => void reveal()}
          >
            <FolderOpen className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-7"
            disabled={detecting}
            onClick={onDetect}
          >
            <RefreshCw className={`size-4 ${detecting ? "animate-spin" : ""}`} />
            {t("detect")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-7"
            disabled={disabled || busy}
            onClick={() => {
              onChange("");
              setEditing(false);
              setError(null);
            }}
          >
            {t("useAutomatic")}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {t(error)}
        </p>
      ) : null}
    </div>
  );
}
