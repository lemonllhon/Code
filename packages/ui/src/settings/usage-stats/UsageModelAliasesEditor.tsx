import { useEffect, useRef, useState } from "react";
import { usageModelAliasesSchema, type UsageModelAliases } from "@lcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { useServices } from "@/hooks/useServices.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";

export function UsageModelAliasesEditor() {
  const { settings, loading, error: readError, update } = useSettings();
  const { settingService } = useServices();
  const { intl } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.usage.alias.${key}` });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const owner = useRef(0);
  useEffect(() => {
    owner.current++;
    setFrom("");
    setTo("");
    setError(false);
    setSaving(false);
    return () => {
      owner.current++;
    };
  }, [settingService]);
  const aliases = settings?.usageModelAliases ?? {};
  const disabled = saving || loading || !settings;
  const save = async (next: UsageModelAliases, clear = false) => {
    const valid = usageModelAliasesSchema.safeParse(next);
    if (!valid.success) {
      setError(true);
      return;
    }
    const version = owner.current;
    setSaving(true);
    setError(false);
    try {
      await update({ usageModelAliases: valid.data });
      if (version === owner.current && clear) {
        setFrom("");
        setTo("");
      }
    } catch {
      if (version === owner.current) setError(true);
    } finally {
      if (version === owner.current) setSaving(false);
    }
  };
  return (
    <details className="rounded-xl border border-border p-4" data-testid="usage-model-aliases">
      <summary className="cursor-pointer text-ui-base font-medium">{m("title")}</summary>
      <p className="my-3 text-ui-sm text-foreground-subtle">{m("note")}</p>
      <form
        className="grid min-w-0 gap-3 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ ...aliases, [from.trim()]: to.trim() }, true);
        }}
      >
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("source")}
          <Input
            data-testid="usage-alias-source"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            maxLength={300}
            disabled={disabled}
          />
        </label>
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("target")}
          <Input
            data-testid="usage-alias-target"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            maxLength={300}
            disabled={disabled}
          />
        </label>
        <Button
          type="submit"
          variant="outline"
          className="self-end"
          disabled={disabled || !from.trim() || !to.trim()}
          data-testid="usage-alias-save"
        >
          {m("save")}
        </Button>
      </form>
      {error || readError ? (
        <p role="alert" className="mt-3 text-ui-sm text-destructive">
          {m("error")}
        </p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {Object.entries(aliases).map(([source, target]) => (
          <li
            key={source}
            data-model-alias={source}
            className="flex min-w-0 items-center justify-between gap-3 text-ui-sm"
          >
            <span className="min-w-0 break-all">
              {source} → {target}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-label={`${m("remove")} ${source}`}
              onClick={() => {
                const next = { ...aliases };
                delete next[source];
                void save(next);
              }}
            >
              {m("remove")}
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
