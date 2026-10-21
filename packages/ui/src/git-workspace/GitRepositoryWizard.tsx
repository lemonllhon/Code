import { useEffect, useRef, useState } from "react";
import {
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useGitRepositoryAcquisition } from "@/hooks/useGitRepositoryAcquisition.js";
import type { GitOperationScope } from "@/hooks/useGitOperationSession.js";
import { useGitManagement } from "@/hooks/useGitManagement.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { GitRepositoryWizardFields } from "./GitRepositoryWizardFields.js";
import { GitOperationResult } from "./GitOperationResult.js";
import { GitOperationRecovery } from "./GitOperationRecovery.js";

/** 项目表单内切换的内容；项目与分组仍由原表单保存，不在仓库创建时另建项目。 */
export function GitRepositoryWizard({
  initialDirectory = "",
  onClose,
  onImported,
  canAddPath,
  ...scope
}: Omit<GitOperationScope, "workspacePath"> & {
  initialDirectory?: string;
  onClose(): void;
  onImported(path: string): Promise<boolean>;
  canAddPath(path: string): boolean;
}) {
  const { intl } = useLCodeIntl();
  const w = (key: string) => intl.formatMessage({ id: `git.repositoryWizard.${key}` });
  const git = useGitRepositoryAcquisition({ ...scope, initialDirectory });
  const management = useGitManagement({ autoDetect: true, services: git.session.services });
  const defaultsApplied = useRef(false);
  useEffect(() => {
    if (management.snapshot && !defaultsApplied.current) {
      defaultsApplied.current = true;
      git.applyInitialBranch(management.snapshot.configuration.initialBranch);
    }
  }, [management.snapshot, git.applyInitialBranch]);
  const [step, setStep] = useState(0);
  const [target, setTarget] = useState<{ path: string; context: object } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<object | null>(git.session.context);
  const attempted = useRef<object | null>(null);
  const busy = useRef(false);
  active.current = git.session.context;
  useEffect(
    () => () => {
      active.current = null;
    },
    [],
  );
  const receipt = git.session.receipt;
  // 中文依据：session 会读取上次收据；只有本次已确认命令的成功结果可交接，不能把旧仓库误当新仓库。
  const acquired =
    target?.context === git.session.context
      ? target.path
      : attempted.current === git.session.context &&
          receipt?.status === "success" &&
          receipt.requestId === git.session.mutationRequestId &&
          ["repository-init", "repository-clone"].includes(receipt.kind)
        ? receipt.targetPath
        : null;
  const uncertain =
    git.session.error === "outcome-unknown" ||
    Boolean(
      receipt &&
      !receipt.resolved &&
      ["running", "unknown", "partial", "conflict"].includes(receipt.status),
    );
  const locked = pending || git.session.pending;
  const allowed = !git.confirmation || canAddPath(git.confirmation.preview.targetPath);
  const canNext = step === 0 || (step === 1 && Boolean(git.directory.trim()));
  const close = () => {
    if (!locked && !busy.current) onClose();
  };
  const attach = async (path: string) => {
    const context = git.session.context;
    setTarget({ path, context });
    if (!(await onImported(path))) throw new Error(w("addFailed"));
    if (active.current === context) onClose();
  };
  const submit = async () => {
    if (busy.current || locked) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (acquired) await attach(acquired);
      else if (!uncertain && allowed) {
        attempted.current = git.session.context;
        const result = await git.confirm();
        if (result?.status === "success" && result.targetPath) await attach(result.targetPath);
      }
    } catch (failure) {
      if (active.current) setError(getErrorMessage(failure));
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };
  const next = async () => {
    if (locked || busy.current) return;
    if (step < 2) {
      if (canNext) setStep(step + 1);
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const preview = await git.prepare();
      if (preview && active.current === git.session.context) setStep(3);
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };
  const steps = ["method", "location", "configuration", "confirmation"];
  return (
    <DialogContent
      showCloseButton={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDownOutside={(event) => event.preventDefault()}
      className="flex h-[calc(100dvh-2rem)] max-h-168 w-[calc(100vw-2rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 md:flex-row"
      data-testid="git-repository-wizard"
    >
      <nav
        aria-label={w("steps")}
        className="shrink-0 border-b border-border bg-surface p-3 md:w-52 md:border-b-0 md:border-r"
      >
        <ol className="grid grid-cols-4 gap-1 md:grid-cols-1 md:gap-2">
          {steps.map((key, index) => (
            <li
              key={key}
              aria-current={step === index ? "step" : undefined}
              className={`flex min-w-0 flex-col gap-1 rounded-lg px-2 py-3 text-ui-sm md:flex-row md:items-center md:gap-3 ${step === index ? "bg-accent text-foreground" : "text-foreground-subtle"}`}
            >
              <span className="font-mono">{index + 1}</span>
              <span className="min-w-0 break-words">{w(key)}</span>
            </li>
          ))}
        </ol>
      </nav>
      <form
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void (step === 3 ? submit() : next());
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border p-4 text-left sm:p-6">
          <DialogTitle className="text-ui-lg font-semibold">{w("title")}</DialogTitle>
          <DialogDescription className="text-ui-sm">{w("projectHint")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <GitRepositoryWizardFields
            step={step}
            git={git}
            management={management}
            disabled={locked || Boolean(acquired) || uncertain}
          />
          {!allowed ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {w("limit")}
            </p>
          ) : null}
          {git.validationError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: "git.workspace.error.invalid-input" })}
            </p>
          ) : null}
          {error ? (
            <p
              role="alert"
              data-testid="git-repository-add-error"
              className="break-words text-ui-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          {acquired ? (
            <p className="break-words text-ui-sm text-foreground-subtle">{w("createdHint")}</p>
          ) : null}
          <GitOperationResult receipt={receipt} error={git.session.error} />
          {uncertain || git.session.error ? (
            <Button
              type="button"
              variant="outline"
              disabled={locked || !git.session.ready}
              onClick={() => void git.session.loadReceipt()}
            >
              {intl.formatMessage({ id: "git.workspace.queryResult" })}
            </Button>
          ) : null}
          <GitOperationRecovery session={git.session} operation={receipt} />
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border p-4">
          <Button type="button" variant="ghost" disabled={locked} onClick={close}>
            {w("returnToProject")}
          </Button>
          {step > 0 ? (
            <Button
              type="button"
              variant="outline"
              data-testid="git-repository-back"
              disabled={locked || Boolean(acquired) || uncertain}
              onClick={() => {
                git.clearPreview();
                setStep(step - 1);
              }}
            >
              {w("back")}
            </Button>
          ) : null}
          {step < 3 ? (
            <Button
              type="submit"
              data-testid="git-repository-next"
              disabled={locked || (step < 2 && !canNext) || uncertain}
            >
              {w(step === 2 ? "preview" : "next")}
            </Button>
          ) : (
            <Button
              type="submit"
              data-testid={acquired ? "git-repository-attach" : "git-import-confirm"}
              disabled={
                locked ||
                (!acquired &&
                  (!git.confirmation ||
                    uncertain ||
                    !allowed ||
                    Boolean(
                      git.mode === "init" &&
                      git.confirmation.preview.parentRepository &&
                      !git.allowNested,
                    )))
              }
            >
              {w(acquired ? "attach" : "create")}
            </Button>
          )}
        </footer>
      </form>
    </DialogContent>
  );
}
