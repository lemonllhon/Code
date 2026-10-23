import { useEffect, useRef, useState } from "react";
import { useWallpaper } from "@/hooks/useWallpaper.js";
import { useWallpaperMedia } from "@/hooks/useWallpaperMedia.js";
import { useAemeathWallpaper } from "@/hooks/useAemeathWallpaper.js";
import type { WallpaperRecord } from "@/store/wallpaperStorage.js";
import type { WallpaperAppearance } from "@/store/wallpaperAppearance.js";
import { releaseMediaDecoder } from "@/lib/releaseMediaDecoder.js";

function AemeathWallpaper({
  reduced,
  onReady,
}: {
  reduced: boolean;
  onReady(value: boolean): void;
}) {
  const container = useAemeathWallpaper(reduced, onReady);
  return <div ref={container} className="h-full w-full" />;
}

function WallpaperMedia({
  record,
  url,
  reduced,
  onReady,
  fill,
}: {
  record: WallpaperRecord;
  fill: WallpaperAppearance["fill"];
  url?: string;
  reduced: boolean;
  onReady(value: boolean): void;
}) {
  const still = useWallpaperMedia(record);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (url && element.getAttribute("src") !== url) element.setAttribute("src", url);
    if (reduced) element.pause();
    else
      void element.play().catch(() => {
        /* 自动播放拒绝时保留已解码静帧。 */
      });
  }, [reduced, url]);
  useEffect(() => {
    const element = video.current;
    if (element && url && element.getAttribute("src") !== url) element.setAttribute("src", url);
    return () => {
      if (element) {
        releaseMediaDecoder(element);
      }
    };
  }, [record.source, url]);
  if (record.source === "aemeath" && url)
    return <AemeathWallpaper reduced={reduced} onReady={onReady} />;
  if (record.source === "baili" && url)
    return (
      <video
        ref={video}
        src={url}
        muted
        loop
        playsInline
        preload="auto"
        className="h-full w-full object-cover"
        style={{ objectFit: fill === "cover" || fill === "contain" ? fill : "none" }}
        data-testid="wallpaper-video"
        onLoadedData={() => onReady(true)}
        onError={() => onReady(false)}
      />
    );
  return still ? (
    <div
      className="h-full w-full"
      data-testid="wallpaper-static"
      style={{
        backgroundImage: `url("${still}")`,
        backgroundPosition: "center",
        backgroundSize: fill === "cover" || fill === "contain" ? fill : "auto",
        backgroundRepeat: fill === "tile" ? "repeat" : "no-repeat",
      }}
    >
      <img
        src={still}
        alt=""
        className="h-full w-full opacity-0"
        data-testid="wallpaper-image"
        onLoad={() => onReady(true)}
        onError={() => onReady(false)}
      />
    </div>
  ) : null;
}

export function WorkspaceWallpaper({ active = true }: { active?: boolean }) {
  const { record, appearance, supported, builtinUrl } = useWallpaper();
  const layer = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(
    () => typeof document !== "undefined" && !document.hidden,
  );
  const [starting, setStarting] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("lcode-startup-active"),
  );
  const [reduced, setReduced] = useState(
    () =>
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [ready, setReady] = useState(false);
  const enabled =
    supported && active && visible && foreground && !starting && record.source !== "none";
  useEffect(() => {
    if (!supported || !layer.current) return;
    const shell = layer.current.parentElement!;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false),
    );
    observer.observe(shell);
    const visibility = () => setForeground(!document.hidden);
    const startup = new MutationObserver(() =>
      setStarting(document.documentElement.classList.contains("lcode-startup-active")),
    );
    startup.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(motion.matches);
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", change);
    return () => {
      observer.disconnect();
      startup.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", change);
    };
  }, [supported]);
  useEffect(() => {
    const shell = layer.current?.parentElement;
    if (enabled && ready) shell?.setAttribute("data-wallpaper-active", "true");
    else shell?.removeAttribute("data-wallpaper-active");
    return () => shell?.removeAttribute("data-wallpaper-active");
  }, [enabled, ready]);
  useEffect(() => {
    const shell = layer.current?.parentElement;
    if (!shell || !supported) return;
    shell.style.setProperty("--wallpaper-panel-opacity", `${appearance.panelOpacity * 100}%`);
    return () => {
      shell.style.removeProperty("--wallpaper-panel-opacity");
    };
  }, [supported, appearance.panelOpacity]);
  useEffect(() => {
    setReady(false);
  }, [record.source, record.image, enabled]);
  if (!supported) return null;
  const url =
    record.source === "baili" || record.source === "aemeath"
      ? builtinUrl(record.source)
      : undefined;
  return (
    <div
      ref={layer}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      data-testid="workspace-wallpaper"
    >
      {enabled ? (
        <div
          className="absolute inset-0"
          data-testid="wallpaper-media"
          style={{ filter: appearance.blur ? `blur(${appearance.blur}px)` : undefined }}
        >
          <WallpaperMedia
            record={record}
            fill={appearance.fill}
            url={url}
            reduced={reduced}
            onReady={setReady}
          />
        </div>
      ) : null}
      <div
        className="absolute inset-0"
        data-wallpaper-tint="true"
        style={{ opacity: appearance.maskOpacity }}
      />
    </div>
  );
}
