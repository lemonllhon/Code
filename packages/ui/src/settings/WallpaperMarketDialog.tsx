import { useEffect, useRef, useState } from "react";
import { Store, Loader2, RefreshCw, Check, ImageIcon, Trash2 } from "lucide-react";
import {
  WALLPAPER_MARKET_CATEGORIES,
  type WallpaperMarketItem,
  type WallpaperMarketPage,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { useWallpaper } from "@/hooks/useWallpaper.js";
import {
  useWallpaperMarket,
  useWallpaperMarketThumbnail,
  useWallpaperMarketThemeColor,
} from "@/hooks/useWallpaperMarket.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { WallpaperColorFilter } from "./WallpaperColorFilter.js";
import type { WallpaperMarketColorChoice } from "@/lib/wallpaperMarketColors.js";

function MarketCard({
  item,
  applied,
  busy,
  downloading,
  onApply,
}: {
  item: WallpaperMarketItem;
  applied: boolean;
  busy: boolean;
  downloading: boolean;
  onApply(): void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `settings.wallpaper.market.${key}` });
  const thumbnail = useWallpaperMarketThumbnail(item.thumbUrl);
  return (
    <button
      type="button"
      onClick={onApply}
      disabled={busy || applied}
      aria-label={intl.formatMessage({ id: "settings.wallpaper.market.apply" }, { id: item.id })}
      title={`${item.width} × ${item.height}`}
      className="group relative overflow-hidden rounded-lg border border-border bg-surface text-left focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-default"
      data-testid={`wallpaper-market-${item.id}`}
    >
      <div className="flex aspect-video items-center justify-center overflow-hidden">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <ImageIcon className="size-5 text-foreground-subtle" />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1 px-2 py-1.5 text-ui-xs text-foreground-subtle">
        <span>{item.width && item.height ? `${item.width} × ${item.height}` : item.id}</span>
        {item.fileSize ? <span>{(item.fileSize / 1024 / 1024).toFixed(1)} MB</span> : null}
      </div>
      {applied || downloading ? (
        <span className="absolute inset-x-0 top-0 flex items-center gap-1 bg-background/90 px-2 py-1 text-ui-xs text-foreground">
          {downloading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : applied ? (
            <Check className="size-3" />
          ) : null}
          {text(downloading ? "applying" : "applied")}
        </span>
      ) : null}
    </button>
  );
}

export function WallpaperMarketDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `settings.wallpaper.market.${key}` });
  const { search, apply } = useWallpaperMarket();
  const { record, busy, removeImage } = useWallpaper();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof WALLPAPER_MARKET_CATEGORIES)[number]>("all");
  const recommendation = useWallpaperMarketThemeColor();
  const [colorChoice, setColorChoice] = useState<WallpaperMarketColorChoice>("theme");
  const color =
    colorChoice === "theme"
      ? recommendation.color
      : colorChoice === "all"
        ? undefined
        : colorChoice;
  const searchKey = JSON.stringify([query, category, color]);
  const [cursor, setCursor] = useState({ key: searchKey, page: 1 });
  const page = cursor.key === searchKey ? cursor.page : 1;
  const setPage = (next: number) => setCursor({ key: searchKey, page: next });
  useEffect(() => {
    // 主题或筛选改变时，首个请求已经使用派生的第一页；只归一游标，不多发旧页请求。
    setCursor((current) => (current.key === searchKey ? current : { key: searchKey, page: 1 }));
  }, [searchKey]);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<WallpaperMarketPage>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [downloading, setDownloading] = useState<string>();
  const applying = useRef(false);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    setFailed(false);
    setResult(undefined);
    void search({ query, category, page, color })
      .then((value) => {
        if (!stale) setResult(value);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    // 关闭、翻页和过滤都结束本代请求；旧网络结果不能覆盖当前列表。
    return () => {
      stale = true;
    };
  }, [open, query, category, page, color, revision, search]);
  const onApply = async (item: WallpaperMarketItem) => {
    if (applying.current || busy) return;
    applying.current = true;
    setDownloading(item.id);
    setApplyFailed(false);
    setDeleteFailed(false);
    try {
      setApplyFailed(!(await apply(item)));
    } finally {
      applying.current = false;
      setDownloading(undefined);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="wallpaper-market">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-ui-lg">
            <Store className="size-4" />
            {text("title")}
          </DialogTitle>
          <DialogDescription>{text("description")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(input.trim());
            setPage(1);
            setRevision((value) => value + 1);
          }}
        >
          <Input
            value={input}
            maxLength={200}
            onChange={(event) => setInput(event.target.value)}
            aria-label={text("searchPlaceholder")}
            placeholder={text("searchPlaceholder")}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline">
            {text("search")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={loading}
            aria-label={text("refresh")}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw className="size-4" />
          </Button>
        </form>
        <div className="flex flex-wrap gap-1" role="group" aria-label={text("category")}>
          {WALLPAPER_MARKET_CATEGORIES.map((value) => (
            <Button
              key={value}
              size="sm"
              variant={category === value ? "secondary" : "ghost"}
              aria-pressed={category === value}
              onClick={() => {
                setCategory(value);
                setPage(1);
              }}
            >
              {text(value)}
            </Button>
          ))}
          <WallpaperColorFilter
            value={colorChoice}
            recommendation={recommendation}
            onChange={(value) => {
              setColorChoice(value);
              setPage(1);
            }}
          />
        </div>
        {record.image && record.marketId ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
            <span className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.wallpaper.market.downloaded" },
                { id: record.marketId },
              )}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDeleteFailed(false);
                setApplyFailed(false);
                void removeImage().then((success) => setDeleteFailed(!success));
              }}
            >
              <Trash2 className="size-4" />
              {text("delete")}
            </Button>
          </div>
        ) : null}
        <div className="h-[min(50dvh,420px)] overflow-y-auto" aria-busy={loading}>
          {loading ? (
            <div
              role="status"
              className="flex justify-center gap-2 py-12 text-ui-base text-foreground-subtle"
            >
              <Loader2 className="size-4 animate-spin" />
              {text("loading")}
            </div>
          ) : failed ? (
            <div className="space-y-3 py-12 text-center">
              <p role="alert" className="text-ui-base text-destructive">
                {text("failed")}
              </p>
              <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
                {text("retry")}
              </Button>
            </div>
          ) : result?.items.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {result.items.map((item) => (
                <MarketCard
                  key={item.id}
                  item={item}
                  busy={busy || Boolean(downloading)}
                  downloading={downloading === item.id}
                  applied={record.source === "custom" && record.marketId === item.id}
                  onApply={() => void onApply(item)}
                />
              ))}
            </div>
          ) : (
            <p className="py-12 text-center text-ui-base text-foreground-subtle">{text("empty")}</p>
          )}
        </div>
        {applyFailed ? (
          <p role="alert" className="text-ui-base text-destructive">
            {text("applyFailed")}
          </p>
        ) : null}
        {deleteFailed ? (
          <p role="alert" className="text-ui-base text-destructive">
            {text("deleteFailed")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 text-ui-caption text-foreground-subtle">
          <a href="https://wallhaven.cc" target="_blank" rel="noreferrer" className="underline">
            {text("credit")}
          </a>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || !result || result.page <= 1}
              onClick={() => setPage(Math.max(1, (result?.page ?? 1) - 1))}
            >
              {text("previous")}
            </Button>
            <span aria-live="polite">{result ? `${result.page} / ${result.lastPage}` : "—"}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || !result || result.page >= result.lastPage}
              onClick={() => setPage((result?.page ?? 1) + 1)}
            >
              {text("next")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
