import { useCallback, useEffect, useRef, useState } from "react";
import {
  gitAcquisitionOptionsSchema,
  type GitAcquisitionOptions,
  type GitAcquisitionPreview,
  type GitAuthenticationReference,
} from "@lcode/shared";
import { usePlatform } from "./usePlatform.js";
import { useGitOperationSession, type GitOperationScope } from "./useGitOperationSession.js";

/** 紧凑导入表单与项目内向导共用原预览/命令/收据路径，每个实例只持有一份 Git 参数。 */
export function useGitRepositoryAcquisition({
  initialDirectory = "",
  onBusyChange,
  ...scope
}: Omit<GitOperationScope, "workspacePath"> & {
  initialDirectory?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const platform = usePlatform();
  const [authentication, setAuthentication] = useState<GitAuthenticationReference | undefined>();
  const [directory, setDirectory] = useState(initialDirectory),
    [mode, setMode] = useState<"init" | "clone">("clone"),
    [url, setUrl] = useState(""),
    [targetName, setTargetName] = useState(""),
    [initialBranch, setInitialBranchState] = useState("main"),
    [allowNested, setAllowNested] = useState(false),
    [browsing, setBrowsing] = useState(false);
  const branchEdited = useRef(false);
  const setInitialBranch = useCallback((value: string) => {
    branchEdited.current = true;
    setInitialBranchState(value);
  }, []);
  const applyInitialBranch = useCallback((value: string) => {
    if (!branchEdited.current) setInitialBranchState(value);
  }, []);
  const session = useGitOperationSession({
    ...scope,
    workspacePath: directory.trim() || undefined,
  });
  const [box, setBox] = useState<{
    context: typeof session.context;
    options: GitAcquisitionOptions;
    preview: GitAcquisitionPreview;
    draftKey: string;
  } | null>(null);
  const [validationError, setValidationError] = useState(false);
  const active = useRef<object | null>(session.context);
  active.current = session.context;
  useEffect(() => {
    active.current = session.context;
    return () => {
      active.current = null;
    };
  }, [session.context]);
  const options: GitAcquisitionOptions = {
    workspacePath: directory.trim(),
    workspaceIdentity: scope.workspaceIdentity?.trim() || undefined,
    mode,
    ...(mode === "clone"
      ? {
          url: url.trim(),
          targetName: targetName.trim(),
          ...(authentication ? { authentication } : {}),
        }
      : { initialBranch: initialBranch.trim(), allowNested }),
  };
  const key = JSON.stringify(options);
  const confirmation = box?.context === session.context && box.draftKey === key ? box : null;
  const browse = async () => {
    if (session.isRemote || !platform.canSelectFilePath) {
      setBrowsing(true);
      return;
    }
    const context = session.context;
    try {
      const path = await platform.selectDirectory();
      if (path && active.current === context) setDirectory(path);
    } catch {
      if (active.current === context) session.reportError("directory-unavailable");
    }
  };
  const prepare = async () => {
    const parsed = gitAcquisitionOptionsSchema.safeParse(options);
    setValidationError(!parsed.success);
    if (!parsed.success) return;
    const preview = await session.run((git) => git.previewRepositoryAcquisition(parsed.data));
    if (preview) setBox({ context: session.context, options: parsed.data, preview, draftKey: key });
    return preview;
  };
  const confirm = async () => {
    if (!confirmation) return;
    onBusyChange?.(true);
    try {
      const receipt = await session.run(
        (git, _scope, requestId) =>
          git.acquireRepository({
            options: confirmation.options,
            requestId,
            preview: confirmation.preview,
          }),
        true,
      );
      if (receipt) setBox(null);
      return receipt;
    } finally {
      onBusyChange?.(false);
    }
  };
  return {
    session,
    options,
    confirmation,
    validationError,
    directory,
    setDirectory,
    mode,
    setMode,
    url,
    setUrl,
    targetName,
    setTargetName,
    initialBranch,
    setInitialBranch,
    applyInitialBranch,
    allowNested,
    setAllowNested,
    browsing,
    setBrowsing,
    browse,
    prepare,
    confirm,
    authentication,
    setAuthentication,
    clearPreview: () => setBox(null),
  };
}
