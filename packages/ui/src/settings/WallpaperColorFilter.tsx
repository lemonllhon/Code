import { useState } from "react";
import { Check } from "lucide-react";
import { WALLPAPER_MARKET_COLORS } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  WallpaperMarketColorChoice,
  getRecommendedWallpaperColor,
} from "@/lib/wallpaperMarketColors.js";

export function WallpaperColorFilter({
  value,
  recommendation,
  onChange,
}: {
  value: WallpaperMarketColorChoice;
  recommendation: ReturnType<typeof getRecommendedWallpaperColor>;
  onChange(value: WallpaperMarketColorChoice): void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `settings.wallpaper.market.${key}` });
  const [open, setOpen] = useState(false);
  const active = value === "theme" ? recommendation.color : value === "all" ? undefined : value;
  const choose = (color: WallpaperMarketColorChoice) => {
    onChange(color);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={text("color")}>
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: active ? `#${active}` : undefined }}
          />
          {text("color")}
          <span className="text-ui-caption text-foreground-subtle">
            {value === "theme"
              ? text("followTheme")
              : value === "all"
                ? text("anyColor")
                : `#${value}`}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64" aria-label={text("color")}>
        <Button
          variant={value === "theme" ? "secondary" : "ghost"}
          className="justify-start"
          aria-pressed={value === "theme"}
          onClick={() => choose("theme")}
        >
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-full border border-border"
            style={{ backgroundColor: `#${recommendation.color}` }}
          />
          {intl.formatMessage(
            { id: "settings.wallpaper.market.themeColor" },
            { theme: intl.formatMessage({ id: recommendation.themeLabelKey }) },
          )}
        </Button>
        <Button
          variant={value === "all" ? "secondary" : "ghost"}
          className="justify-start"
          aria-pressed={value === "all"}
          onClick={() => choose("all")}
        >
          {text("anyColor")}
        </Button>
        <div className="grid grid-cols-6 gap-2" role="group" aria-label={text("palette")}>
          {WALLPAPER_MARKET_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-pressed={value === color}
              aria-label={intl.formatMessage(
                { id: "settings.wallpaper.market.colorOption" },
                { color },
              )}
              title={`#${color}`}
              onClick={() => choose(color)}
              style={{ backgroundColor: `#${color}` }}
              className="flex aspect-square items-center justify-center rounded-md border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              {active === color ? (
                <Check
                  aria-hidden="true"
                  className="size-4 text-white drop-shadow-[0_1px_2px_black]"
                />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
