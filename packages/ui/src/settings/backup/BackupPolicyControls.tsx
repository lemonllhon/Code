import { useState } from "react";
import type { BackupKind, BackupLocation, BackupSelection } from "@lcode/services";
import type { useAutomaticBackup } from "@/hooks/useAutomaticBackup.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
type BackupController = ReturnType<typeof useAutomaticBackup>;
export function BackupPolicyControls({
  backup,
  kind,
  selection,
  onSaved,
}: {
  backup: BackupController;
  kind: BackupKind;
  selection?: BackupSelection;
  onSaved?: () => Promise<void>;
}) {
  const { intl, locale } = useLCodeIntl();
  const [password, setPassword] = useState("");
  const text = (id: string) => intl.formatMessage({ id: `settings.backup.${id}` });
  const draft = backup.draft;
  if (!draft) return null;
  const update = (patch: Partial<typeof draft>) => backup.setDraft({ ...draft, ...patch });
  const locationName = (location: BackupLocation) =>
    location === "local"
      ? text("local")
      : location === "oss"
        ? intl.formatMessage({ id: "settings.gitBackup.provider.oss" })
        : "MinIO";
  return (
    <div className="space-y-3" data-testid="backup-policy">
      <label className="flex items-center gap-2 text-ui-base">
        <Checkbox
          checked={draft.localEnabled}
          disabled={backup.busy}
          onCheckedChange={(value) => update({ localEnabled: Boolean(value) })}
        />
        {text("localEnabled")}
      </label>
      <label className="block space-y-1 text-ui-caption">
        {text("localDirectory")}
        <Input
          value={draft.localDirectory ?? ""}
          placeholder={text("defaultDirectory")}
          disabled={backup.busy}
          onChange={(event) => update({ localDirectory: event.target.value || null })}
        />
      </label>
      {kind === "providers" ? (
        <>
          <label className="flex items-center gap-2 text-ui-base">
            <Checkbox
              checked={draft.providers.enabled}
              disabled={backup.busy}
              onCheckedChange={(value) =>
                update({ providers: { ...draft.providers, enabled: Boolean(value) } })
              }
            />
            {text("autoProviders")}
          </label>
          <label className="block space-y-1 text-ui-caption">
            {text("interval")}
            <Input
              type="number"
              min={5}
              max={1440}
              value={draft.providers.intervalMinutes}
              className="w-32"
              disabled={backup.busy}
              onChange={(event) =>
                update({
                  providers: { ...draft.providers, intervalMinutes: Number(event.target.value) },
                })
              }
            />
          </label>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-2 text-ui-caption">{text("locations")}</legend>
            {(["local", "oss", "minio"] as const).map((location) => (
              <label key={location} className="flex items-center gap-2 text-ui-base">
                <Checkbox
                  checked={draft.providers.locations.includes(location)}
                  disabled={backup.busy}
                  onCheckedChange={(value) =>
                    update({
                      providers: {
                        ...draft.providers,
                        locations: value
                          ? [...new Set([...draft.providers.locations, location])]
                          : draft.providers.locations.filter((item) => item !== location),
                      },
                    })
                  }
                />
                {locationName(location)}
              </label>
            ))}
          </fieldset>
          <p className="text-ui-caption text-foreground-subtle">{text("selectionSaveNote")}</p>
        </>
      ) : null}
      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-2 text-ui-caption">{text("retention")}</legend>
        {(["local", "oss", "minio"] as const).map((location) => (
          <label key={location} className="space-y-1 text-ui-caption">
            {locationName(location)}
            <Input
              type="number"
              min={0}
              max={100}
              value={draft.retention[location] ?? 0}
              className="w-24"
              disabled={backup.busy}
              onChange={(event) =>
                update({
                  retention: { ...draft.retention, [location]: Number(event.target.value) || null },
                })
              }
            />
          </label>
        ))}
      </fieldset>
      <p className="text-ui-caption text-foreground-subtle">{text("retentionNote")}</p>
      <Button
        size="sm"
        disabled={backup.busy}
        onClick={() =>
          void backup
            .save(
              kind === "providers"
                ? { ...draft, providers: { ...draft.providers, selection: selection ?? null } }
                : draft,
            )
            .then(() => onSaved?.())
        }
      >
        {text("save")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={backup.busy}
        onClick={() => void backup.resetPolicy()}
      >
        {text("reloadPolicy")}
      </Button>
      {backup.state?.nextProviderCheckAt && kind === "providers" ? (
        <p className="text-ui-caption">
          {text("nextCheck")}:{" "}
          {new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
            new Date(backup.state.nextProviderCheckAt),
          )}
        </p>
      ) : null}
      {backup.state?.lastResult ? (
        <ul className="space-y-1 text-ui-caption" aria-label={text("lastResult")}>
          {backup.state.lastResult.results.map((item) => (
            <li key={item.location}>
              {locationName(item.location)}:{" "}
              {text(
                item.status === "created"
                  ? "completed"
                  : item.status === "skipped-unchanged"
                    ? "unchanged"
                    : "failed",
              )}
              {item.error ? ` · ${item.error}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="space-y-2 border-t border-border pt-3">
        <h3 className="text-ui-base font-medium">{text("recoveryKit")}</h3>
        <p className="text-ui-caption text-foreground-subtle">{text("recoveryKitNote")}</p>
        <Input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-label={text("password")}
          placeholder={text("password")}
          disabled={backup.busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={backup.busy || password.length < 8}
            onClick={() => void backup.exportKit(password)}
          >
            {text("exportKit")}
          </Button>
          <label className="min-w-0 text-ui-caption">
            {text("importKit")}
            <input
              type="file"
              accept=".json,.pem"
              disabled={backup.busy}
              aria-label={text("importKit")}
              className="block max-w-full text-ui-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void backup.importKit(file, password);
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
