import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { useGitRepositoryAcquisition } from "@/hooks/useGitRepositoryAcquisition.js";
import { GitRepositoryAccountPicker } from "./GitRepositoryAccountPicker.js";
import type { useGitManagement } from "@/hooks/useGitManagement.js";

export function GitRepositoryWizardFields({
  step,
  git,
  management,
  disabled,
}: {
  step: number;
  git: ReturnType<typeof useGitRepositoryAcquisition>;
  management: ReturnType<typeof useGitManagement>;
  disabled: boolean;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.workspace.${key}` });
  const w = (key: string) => intl.formatMessage({ id: `git.repositoryWizard.${key}` });
  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    maxLength?: number,
  ) => (
    <label className="block space-y-2 text-ui-base">
      <span>{label}</span>
      <Input
        aria-label={label}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
  if (step === 0)
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {(["clone", "init"] as const).map((mode) => (
          <Button
            key={mode}
            type="button"
            aria-label={t(mode)}
            variant={git.mode === mode ? "secondary" : "outline"}
            className="h-auto min-h-24 flex-col items-start whitespace-normal p-4 text-left"
            aria-pressed={git.mode === mode}
            disabled={disabled}
            onClick={() => {
              git.setMode(mode);
              git.clearPreview();
            }}
          >
            <span className="text-ui-lg font-medium">{t(mode)}</span>
            <span className="text-ui-sm text-foreground-subtle">{t(`${mode}Hint`)}</span>
          </Button>
        ))}
      </div>
    );
  if (step === 1)
    return (
      <div className="space-y-4">
        <label className="block space-y-2 text-ui-base">
          <span>{t(git.mode === "clone" ? "parentDirectory" : "initDirectory")}</span>
          <div className="flex min-w-0 gap-2">
            <Input
              aria-label={t("directory")}
              value={git.directory}
              disabled={disabled}
              onChange={(e) => git.setDirectory(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => void git.browse()}
            >
              {t("browse")}
            </Button>
          </div>
        </label>
        {git.browsing ? (
          <div className="h-56 min-w-0 overflow-auto border border-border rounded-lg">
            <DirectoryBrowser
              embedded
              services={git.session.services}
              onSelect={(path) => {
                git.setDirectory(path);
                git.setBrowsing(false);
              }}
              onCancel={() => git.setBrowsing(false)}
            />
          </div>
        ) : null}
      </div>
    );
  if (step === 2)
    return (
      <div className="space-y-4">
        {git.mode === "clone" ? (
          <>
            {field(t("cloneUrl"), git.url, git.setUrl)}
            {field(t("targetName"), git.targetName, git.setTargetName, 100)}
          </>
        ) : (
          <>
            {field(t("initialBranch"), git.initialBranch, git.setInitialBranch)}
            <label className="flex items-start gap-2 text-ui-base">
              <input
                type="checkbox"
                checked={git.allowNested}
                disabled={disabled}
                className="mt-1 size-4 shrink-0"
                onChange={(e) => git.setAllowNested(e.target.checked)}
              />
              <span>{t("allowNested")}</span>
            </label>
          </>
        )}
        <GitRepositoryAccountPicker git={git} management={management} disabled={disabled} />
        <p className="text-ui-sm text-foreground-subtle">{t(`${git.mode}Hint`)}</p>
      </div>
    );
  return (
    <dl className="space-y-3 text-ui-base" data-testid="git-import-confirmation">
      {[
        [w("method"), t(git.mode)],
        ...(git.mode === "clone"
          ? [
              [
                intl.formatMessage({ id: "settings.gitManagement.repositoryAccount" }),
                management.snapshot?.accounts.find((a) => a.id === git.authentication?.id)?.name ??
                  intl.formatMessage({ id: "settings.gitManagement.system" }),
              ],
            ]
          : []),
        [
          w("target"),
          git.confirmation?.preview.targetPath ?? git.session.receipt?.targetPath ?? "",
        ],
        [
          t(git.mode === "clone" ? "cloneUrl" : "initialBranch"),
          git.mode === "clone" ? git.url : git.initialBranch,
        ],
        ...(git.confirmation?.preview.parentRepository
          ? [[t("parentRepository"), git.confirmation.preview.parentRepository]]
          : []),
      ].map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-ui-sm text-foreground-subtle">{label}</dt>
          <dd className="whitespace-pre-wrap break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
