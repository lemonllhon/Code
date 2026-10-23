interface PlaybackViewport {
  width: number;
  height: number;
  pixelRatio: number;
  cores?: number;
  memoryGiB?: number;
}

const constrained = ({ cores, memoryGiB }: PlaybackViewport) =>
  (cores !== undefined && cores > 0 && cores <= 4) ||
  (memoryGiB !== undefined && memoryGiB > 0 && memoryGiB <= 4);

export function readPlaybackViewport(width = innerWidth, height = innerHeight): PlaybackViewport {
  return {
    width,
    height,
    pixelRatio: devicePixelRatio || 1,
    cores: navigator.hardwareConcurrency,
    memoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  };
}

export function selectStartupVideoFile(view: PlaybackViewport) {
  // 原片在小窗口也一直解码 4K/60；按完整显示后的物理尺寸一次选源，不在播放中切换。
  const physicalWidth = Math.min(view.width, (view.height * 16) / 9) * view.pixelRatio;
  return constrained(view) || physicalWidth <= 1920 ? "baili-lite.mp4" : "baili.mp4";
}

export function getCanvasPlaybackBudget(view: PlaybackViewport) {
  const limited = constrained(view);
  const width = Math.max(1, view.width),
    height = Math.max(1, view.height);
  const maxPixels = limited ? 1280 * 720 : 1920 * 1080;
  // 只限宽会漏掉竖屏 / 高 DPI 的超大纹理；同时限制总像素，不改 CSS 尺寸和剧情时钟。
  const ratio = Math.min(
    view.pixelRatio,
    2,
    (limited ? 1280 : 1920) / width,
    Math.sqrt(maxPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    frameIntervalMs: 1000 / (limited ? 30 : 60),
  };
}
