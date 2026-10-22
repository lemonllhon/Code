import { useEffect, useRef, useState } from "react";
import {
  gitBackupWorkspaceKey,
  type BackupKind,
  type BackupSelection,
  type IGitBackupService,
} from "@lcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useGitBackupRouting, type GitBackupSectionTarget } from "@/hooks/useGitBackupRouting.js";
import { useGitBackup } from "@/hooks/useGitBackup.js";
import { useAutomaticBackup } from "@/hooks/useAutomaticBackup.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { GitBackupSectionController } from "@/settings/GitBackupSection.js";
import { GitBackupDestinationFields } from "@/settings/git-backup/GitBackupDestinationFields.js";
import { BackupPolicyControls } from "@/settings/backup/BackupPolicyControls.js";
import { BackupVersionManager } from "@/settings/backup/BackupVersionManager.js";

type Route = ReturnType<typeof useGitBackupRouting>;
export function AutomaticBackupSection(props: GitBackupSectionTarget) {
  const route = useGitBackupRouting(props);
  const services = useServices();
  return (
    <AutomaticBackupSettingsView
      route={route}
      providerService={services.gitBackupService ?? null}
    />
  );
}
export function AutomaticBackupSettingsView({
  route,
  providerService,
}: {
  route: Route;
  providerService: IGitBackupService | null;
}) {
  const { intl } = useLCodeIntl();
  const text = (id: string) => intl.formatMessage({ id: `settings.backup.${id}` });
  return (
    <Tabs defaultValue="git" className="min-w-0 space-y-4">
      <TabsList aria-label={text("types")}>
        <TabsTrigger value="git">{text("git")}</TabsTrigger>
        <TabsTrigger value="providers">{text("providers")}</TabsTrigger>
      </TabsList>
      <TabsContent
        value="git"
        forceMount
        className="min-w-0 space-y-4 data-[state=inactive]:hidden"
      >
        <GitBackupSectionController key={route.controllerKey} {...route} />
        <BackupLifecyclePanel
          key={`git-${route.controllerKey}`}
          service={route.service}
          kind="git"
          route={route}
        />
      </TabsContent>
      <TabsContent
        value="providers"
        forceMount
        className="min-w-0 space-y-4 data-[state=inactive]:hidden"
      >
        <p className="text-ui-caption text-foreground-subtle">{text("providerScope")}</p>
        <ProviderBackupConfiguration service={providerService} />
        <BackupLifecyclePanel service={providerService} kind="providers" />
      </TabsContent>
    </Tabs>
  );
}
function ProviderBackupConfiguration({ service }: { service: IGitBackupService | null }) {
  const backup = useGitBackup({
    service,
    target: null,
    connectionKind: "local-ready",
    destinationOnly: true,
  });
  const { intl } = useLCodeIntl();
  if (!backup.draft) return null;
  const busy = Boolean(backup.operation);
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <h3 className="text-ui-base font-medium">
        {intl.formatMessage({ id: "settings.gitBackup.shared" })}
      </h3>
      <div className="flex flex-wrap gap-2">
        {(["oss", "minio"] as const).map((provider) => (
          <Button
            key={provider}
            size="sm"
            variant={backup.provider === provider ? "default" : "outline"}
            disabled={busy}
            onClick={() => backup.selectProvider(provider)}
          >
            {intl.formatMessage({ id: `settings.gitBackup.provider.${provider}` })}
          </Button>
        ))}
      </div>
      <GitBackupDestinationFields backup={backup} busy={busy} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void backup.save()}>
          {intl.formatMessage({ id: "settings.gitBackup.save" })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void backup.testConnection()}
        >
          {intl.formatMessage(
            { id: "settings.gitBackup.testProvider" },
            {
              provider: intl.formatMessage({
                id: `settings.gitBackup.provider.${backup.provider}`,
              }),
            },
          )}
        </Button>
      </div>
      {backup.error ? (
        <p role="alert" className="break-words text-ui-caption text-destructive">
          {intl.formatMessage({ id: backup.error.id }, { error: backup.error.detail ?? "" })}
        </p>
      ) : null}
      {backup.notice ? (
        <p role="status" className="text-ui-caption">
          {intl.formatMessage({ id: backup.notice.id }, { error: backup.notice.detail ?? "" })}
        </p>
      ) : null}
      {backup.testResult ? (
        <p role="status" className="break-words text-ui-caption">
          {backup.testResult.ok
            ? intl.formatMessage({ id: "settings.gitBackup.ossConfig.testSuccess" })
            : backup.testResult.error}
        </p>
      ) : null}
    </section>
  );
}
function BackupLifecyclePanel({
  service,
  kind,
  route,
}: {
  service: IGitBackupService | null;
  kind: BackupKind;
  route?: Route;
}) {
  const backup = useAutomaticBackup(service, kind, route?.target);
  const { intl } = useLCodeIntl();
  const text = (id: string) => intl.formatMessage({ id: `settings.backup.${id}` });
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const initialized = useRef(false);
  useEffect(() => {
    // 已保存的自动备份范围属于 Host；首次显示不能将它误重置为全部。
    if (kind !== "providers" || !backup.state || initialized.current) return;
    initialized.current = true;
    const selection = backup.state.policy.providers.selection;
    setSelectionMode(Boolean(selection));
    setSelected([...(selection?.providerIds ?? []), ...(selection?.accountIds ?? [])]);
  }, [backup.state, kind]);
  const items = backup.state?.providerItems ?? [];
  const selection: BackupSelection | undefined = selectionMode
    ? {
        providerIds: selected.filter((id) =>
          items.some((item) => item.id === id && item.type === "provider"),
        ),
        accountIds: selected.filter((id) =>
          items.some((item) => item.id === id && item.type === "account"),
        ),
      }
    : undefined;
  return (
    <section className="min-w-0 space-y-4" data-testid={`backup-lifecycle-${kind}`}>
      <p className="text-ui-caption text-foreground-subtle">{text("changeOnly")}</p>
      {backup.error || backup.state?.error ? (
        <p role="alert" className="break-words text-ui-caption text-destructive">
          {backup.error ?? backup.state?.error}
        </p>
      ) : null}
      {backup.notice ? (
        <p role="status" className="text-ui-caption">
          {intl.formatMessage({ id: backup.notice })}
        </p>
      ) : null}
      {kind === "providers" ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-ui-base">
            <Checkbox
              checked={selectionMode}
              disabled={backup.busy}
              onCheckedChange={(value) => setSelectionMode(Boolean(value))}
            />
            {text("selectedOnly")}
          </label>
          {selectionMode
            ? items.map((item) => (
                <label
                  key={`${item.type}-${item.id}`}
                  className="flex items-center gap-2 break-all text-ui-caption"
                >
                  <Checkbox
                    checked={selected.includes(item.id)}
                    disabled={backup.busy}
                    onCheckedChange={(value) =>
                      setSelected((current) =>
                        value ? [...current, item.id] : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  {item.label}
                </label>
              ))
            : null}
        </div>
      ) : null}
      <Button
        size="sm"
        disabled={
          backup.busy ||
          !backup.state ||
          (kind === "git" && !route?.target) ||
          (selectionMode && !selected.length)
        }
        onClick={() => void backup.backup(selection)}
      >
        {text("now")}
      </Button>
      {kind === "git"
        ? route?.workspaceCandidates.map((target) => (
            <div
              key={gitBackupWorkspaceKey(target)}
              className="flex min-w-0 items-center justify-between gap-2"
            >
              <span className="break-all text-ui-caption">{target.workspacePath}</span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={backup.busy}
                onClick={() => void backup.backup(undefined, target)}
              >
                {text("backupOne")}
              </Button>
            </div>
          ))
        : null}
      <BackupPolicyControls backup={backup} kind={kind} selection={selection} />
      <BackupVersionManager backup={backup} kind={kind} />
    </section>
  );
}
