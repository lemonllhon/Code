import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useWallpaper } from "@/hooks/useWallpaper.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { WALLPAPER_SOURCES, type WallpaperSource } from "@/store/wallpaperStorage.js";
import { SettingsRow } from "./SettingsPageParts.js";
import { WALLPAPER_FILL_MODES, type WallpaperAppearance } from "@/store/wallpaperAppearance.js";
import { useWallpaperMarket } from "@/hooks/useWallpaperMarket.js";
import { WallpaperMarketDialog } from "./WallpaperMarketDialog.js";

export function WallpaperSettingsSection() {
  const { intl } = useLCodeIntl();
  const {
    record,
    appearance,
    updateAppearance,
    supported,
    busy,
    failed,
    select,
    importImage,
    builtinUrl,
  } = useWallpaper();
  const market = useWallpaperMarket();
  const [marketOpen, setMarketOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const text = (key: string) => intl.formatMessage({ id: `settings.wallpaper.${key}` });
  if (!supported) return null;
  return (
    <div className="min-w-0 space-y-3" data-testid="wallpaper-settings">
      <h3 className="text-ui-lg font-semibold text-foreground">{text("title")}</h3>
      <p className="text-ui-base text-foreground-subtle">{text("description")}</p>
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardContent className="space-y-0 px-0">
          <SettingsRow
            label={text("source")}
            control={
              <Select
                value={record.source}
                disabled={busy}
                onValueChange={(value: WallpaperSource) => void select(value)}
              >
                <SelectTrigger aria-label={text("source")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLPAPER_SOURCES.map((source) => (
                    <SelectItem
                      key={source}
                      value={source}
                      disabled={
                        (source === "custom" && !record.image) ||
                        ((source === "baili" || source === "aemeath") && !builtinUrl(source))
                      }
                    >
                      {text(source)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={text("image")}
            control={
              <>
                <input
                  ref={input}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
                  className="hidden"
                  aria-label={text("chooseImage")}
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void importImage(file);
                  }}
                />
                <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
                  {text("chooseImage")}
                </Button>
              </>
            }
          />
          {market.supported ? (
            <SettingsRow
              label={text("market.title")}
              control={
                <Button variant="outline" onClick={() => setMarketOpen(true)}>
                  {text("market.title")}
                </Button>
              }
            />
          ) : null}
          <SettingsRow
            label={text("fill")}
            control={
              <Select
                value={appearance.fill}
                onValueChange={(fill: WallpaperAppearance["fill"]) =>
                  void updateAppearance({ fill })
                }
              >
                <SelectTrigger aria-label={text("fill")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLPAPER_FILL_MODES.map((fill) => (
                    <SelectItem key={fill} value={fill}>
                      {text(`fill.${fill}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          {(["maskOpacity", "blur", "panelOpacity"] as const).map((key) => (
            <SettingsRow
              key={key}
              label={text(key)}
              description={key === "blur" ? undefined : text(`${key}Hint`)}
              control={
                <div className="flex w-full min-w-0 items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={key === "blur" ? 24 : key === "maskOpacity" ? 99 : 100}
                    step={1}
                    aria-label={text(key)}
                    value={key === "blur" ? appearance[key] : Math.round(appearance[key] * 100)}
                    onChange={(event) =>
                      void updateAppearance({
                        [key]: Number(event.currentTarget.value) / (key === "blur" ? 1 : 100),
                      })
                    }
                    className="min-w-0 flex-1 accent-brand"
                  />
                  <output className="w-10 shrink-0 text-right text-ui-caption tabular-nums text-foreground-subtle">
                    {key === "blur"
                      ? `${appearance[key]} px`
                      : `${Math.round(appearance[key] * 100)}%`}
                  </output>
                </div>
              }
            />
          ))}
        </CardContent>
      </Card>
      {market.supported ? (
        <WallpaperMarketDialog open={marketOpen} onOpenChange={setMarketOpen} />
      ) : null}
      {!builtinUrl("baili") ? (
        <p className="text-ui-caption text-foreground-subtle">{text("unavailable")}</p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-ui-base text-destructive">
          {text("failed")}
        </p>
      ) : null}
    </div>
  );
}
