import type { useGitManagement } from "@/hooks/useGitManagement.js";
import type { useGitRepositoryAcquisition } from "@/hooks/useGitRepositoryAcquisition.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

export function GitRepositoryAccountPicker({
  git,
  management,
  disabled,
}: {
  git: ReturnType<typeof useGitRepositoryAcquisition>;
  management: ReturnType<typeof useGitManagement>;
  disabled: boolean;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.gitManagement.${key}` });
  if (git.mode !== "clone") return null;
  const reference = git.authentication ? JSON.stringify(git.authentication) : "";
  const accounts =
    management.snapshot?.accounts.filter((account) => {
      try {
        const scp = git.url.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
        const target = new URL(
            git.url.includes("://")
              ? git.url
              : `ssh://${scp?.[1] ? scp[1] + "@" : ""}${scp?.[2]}/${scp?.[3]}`,
          ),
          server = new URL(account.serverUrl),
          prefix = server.pathname.replace(/\/$/, "");
        return (
          target.protocol === server.protocol &&
          target.host.toLowerCase() === server.host.toLowerCase() &&
          (target.pathname === prefix || target.pathname.startsWith(prefix + "/"))
        );
      } catch {
        return false;
      }
    }) ?? [];
  return (
    <div className="space-y-2">
      <label className="block space-y-2 text-ui-base">
        <span>{t("repositoryAccount")}</span>
        <select
          aria-label={t("repositoryAccount")}
          data-testid="git-repository-account"
          value={reference}
          disabled={disabled}
          className="h-9 w-full min-w-0 rounded-md border border-input-border bg-input px-2 text-ui-base"
          onChange={(e) =>
            git.setAuthentication(e.target.value ? JSON.parse(e.target.value) : undefined)
          }
        >
          <option value="">{t("system")}</option>
          {accounts.map((account) => (
            <option
              key={account.id}
              value={JSON.stringify({ id: account.id, revision: account.revision })}
            >
              {account.name} · {account.username}
            </option>
          ))}
          {reference &&
          !accounts.some(
            (a) => JSON.stringify({ id: a.id, revision: a.revision }) === reference,
          ) ? (
            <option value={reference} disabled>
              {t("accountUnavailable")}
            </option>
          ) : null}
        </select>
      </label>
      <p className="text-ui-sm text-foreground-subtle">{t("repositoryAccountHint")}</p>
      {management.error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {t(management.error)}
        </p>
      ) : null}
      {management.available ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || management.pending}
          onClick={() => void management.reload()}
        >
          {t("reloadAccounts")}
        </Button>
      ) : null}
    </div>
  );
}
