import { useGitRepositoryAuthentication } from "@/hooks/useGitRepositoryAuthentication.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

export function GitRemoteAuthentication(
  props: Parameters<typeof useGitRepositoryAuthentication>[0],
) {
  const auth = useGitRepositoryAuthentication(props),
    { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.authentication.${key}` });
  if (!auth.available) return null;
  return (
    <section
      className="space-y-2 border-b border-border px-3 py-2"
      data-testid="git-remote-authentication"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm font-medium">{t("title")}</span>
        <Button size="sm" variant="ghost" disabled={auth.pending} onClick={auth.refresh}>
          {t("refresh")}
        </Button>
      </div>
      <p className="text-ui-xs text-foreground-subtle">{t("hint")}</p>
      {auth.error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {t(auth.error)}
        </p>
      ) : null}
      {auth.snapshot?.remotes.map((remote) =>
        remote.urls.map((target) => {
          const choices = auth.snapshot!.choices.filter((account) => {
            try {
              const scp = target.url.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/),
                url = new URL(
                  target.url.includes("://")
                    ? target.url
                    : `ssh://${scp?.[1] ? scp[1] + "@" : ""}${scp?.[2]}/${scp?.[3]}`,
                ),
                server = new URL(account.serverUrl),
                prefix = server.pathname.replace(/\/$/, "");
              return (
                url.protocol === server.protocol &&
                url.host === server.host &&
                (!url.username || decodeURIComponent(url.username) === account.username) &&
                (!target.usernameHint || target.usernameHint === account.username) &&
                (url.pathname === prefix || url.pathname.startsWith(prefix + "/"))
              );
            } catch {
              return false;
            }
          });
          return (
            <label key={remote.name + target.url} className="block min-w-0 space-y-1 text-ui-sm">
              <span className="block truncate text-foreground-subtle" title={target.url}>
                {remote.name} · {target.url}
              </span>
              <select
                aria-label={`${t("account")} ${remote.name} ${target.url}`}
                value={target.selection ?? ""}
                disabled={auth.pending || Boolean(auth.error)}
                onChange={(e) => void auth.select(target.url, e.target.value || null)}
                className="h-8 w-full min-w-0 rounded border border-input-border bg-input px-2 text-mobile-input-safe md:text-ui-sm"
              >
                <option value="">{t("automatic")}</option>
                {choices.map((account) => (
                  <option key={account.key} value={account.key}>
                    {account.name} · {account.username}
                    {account.key.startsWith("detected:") ? ` (${t("detected")})` : ""}
                  </option>
                ))}
                {target.stale ? (
                  <option value={target.selection ?? ""} disabled>
                    {t("stale")}
                  </option>
                ) : null}
              </select>
              {target.stale ? (
                <span role="alert" className="text-ui-xs text-destructive">
                  {t("stale")}
                </span>
              ) : null}
            </label>
          );
        }),
      )}
    </section>
  );
}
