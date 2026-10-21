import type { GitDetectedAccount } from "@lcode/shared";
import { Download, UserRound } from "lucide-react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

export function GitDetectedAccountList({
  accounts,
  pending,
  onImport,
}: {
  accounts: GitDetectedAccount[];
  pending: boolean;
  onImport: (candidateId: string) => void;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.gitManagement.${key}` });
  if (!accounts.length) return null;
  return (
    <div className="min-w-0" data-testid="git-detected-accounts">
      <p className="px-3 pt-3 text-ui-sm text-foreground-subtle">{t("availableAccounts")}</p>
      {accounts.map((candidate) => (
        <div
          key={candidate.candidateId}
          className="flex min-w-0 items-center gap-3 px-3 py-3"
          data-testid="git-detected-account"
        >
          <UserRound className="size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 flex-1 text-ui-base">
            <div className="break-words font-medium">{candidate.name}</div>
            <p className="break-all text-ui-sm text-foreground-subtle">
              {candidate.serverUrl} · {candidate.username}
            </p>
            <p className="break-words text-ui-sm text-foreground-subtle">
              {["windows-credentials", "macos-keychain", "linux-secret-service"].includes(
                candidate.source,
              )
                ? t(`source.${candidate.source}`)
                : candidate.source}{" "}
              · {t(candidate.auth)}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !candidate.canImport}
            onClick={() => onImport(candidate.candidateId)}
          >
            <Download className="size-3.5" />
            {t("import")}
          </Button>
        </div>
      ))}
    </div>
  );
}
