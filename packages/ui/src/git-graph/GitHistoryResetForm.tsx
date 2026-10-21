import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitHistoryController } from "@/hooks/useGitHistory.js";
export function GitHistoryResetForm({ history }: { history: GitHistoryController }) {
  const [mode, setMode] = useState<"soft" | "mixed" | "hard">("soft");
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.history.${key}` });
  const disabled = !history.session.ready || history.session.pending;
  return (
    <div
      className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2"
      data-testid="git-history-reset-form"
    >
      <label className="flex items-center gap-2">
        Reset
        <select
          aria-label={t("resetMode")}
          className="h-7 min-w-0 flex-1 rounded-sm border border-input-border bg-input px-2 text-mobile-input-safe md:text-ui-sm"
          disabled={disabled}
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as typeof mode);
            history.cancel();
          }}
        >
          {(["soft", "mixed", "hard"] as const).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <p className="text-ui-xs text-foreground-subtle">{t(`resetMode.${mode}`)}</p>
      <p className="text-ui-xs text-foreground-subtle">{t("resetBackup")}</p>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            void history.prepareReset(mode);
          }}
        >
          {t("preview")}
        </Button>
      </div>
    </div>
  );
}
