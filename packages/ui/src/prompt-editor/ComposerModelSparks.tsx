import { memo, useEffect, useRef, type CSSProperties } from "react";

// 固定相位让重渲染保持同一片火花；窄屏保留的前 16 颗仍覆盖整个输入框。
const SPARKS = [
  [7, 2.5, 5.8, -2.1, 9],
  [64, 1.8, 6.7, -4.8, -14],
  [32, 3, 4.9, -1.4, 12],
  [89, 2, 7.1, -5.6, -10],
  [18, 1.5, 6.1, -4.2, -6],
  [75, 3.2, 5.3, -0.9, 14],
  [46, 2.2, 7.4, -3.6, -12],
  [96, 1.6, 5.6, -2.8, -8],
  [4, 1.8, 6.4, -5.1, 11],
  [57, 2.8, 4.7, -1.9, -9],
  [26, 1.7, 7.2, -6.2, 13],
  [83, 2.6, 5.9, -3.3, -15],
  [39, 2, 6.8, -0.6, 8],
  [69, 1.5, 5.1, -3.9, -7],
  [12, 2.7, 6.3, -1.1, 16],
  [92, 2.1, 5.4, -4.4, -13],
  [52, 1.6, 7, -2.5, 10],
  [22, 2.3, 5.7, -4.9, -11],
  [80, 1.8, 6.6, -1.7, 7],
  [43, 2.9, 4.8, -3.1, -14],
  [60, 1.4, 7.3, -5.8, 12],
  [9, 2, 6.2, -3.7, -5],
  [35, 1.9, 5.5, -0.4, 15],
  [72, 2.4, 6.9, -5.3, -9],
].map(([x, size, duration, delay, drift]) => ({
  left: `${x}%`,
  width: size! * 1.25,
  height: size! * 1.25,
  animationDuration: `${duration}s`,
  animationDelay: `${delay}s`,
  "--composer-spark-drift": `${drift}px`,
})) satisfies CSSProperties[];

/** 装饰层只观察原生输入，不读取正文或参与 Composer 草稿写入。 */
export const ComposerModelSparks = memo(function ComposerModelSparks({
  intensity,
}: {
  intensity: number;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const shell = root?.parentElement;
    if (!root || !shell) return;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce), (forced-colors: active)");
    const baseRate = 0.55 + intensity;
    let animations: Animation[] = [];
    let frame: number | undefined;
    let lastInput = 0;
    const applyBoost = (boost: number) => {
      root.style.setProperty("--composer-spark-boost", String(boost));
      for (const animation of animations) animation.updatePlaybackRate(baseRate * (1 + boost * 2));
    };
    const refreshAnimations = () => {
      animations = root
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation instanceof CSSAnimation && animation.animationName === "composer-spark-rise",
        );
    };
    const reset = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      refreshAnimations();
      applyBoost(0);
    };
    const animateInput = (now: number) => {
      const remaining = Math.max(0, 1 - Math.max(0, now - lastInput - 100) / 650);
      applyBoost(remaining * remaining);
      frame = remaining > 0 ? requestAnimationFrame(animateInput) : undefined;
    };
    const onInput = (event: Event) => {
      if (
        reducedMotion.matches ||
        !(event.target instanceof Element) ||
        !event.target.closest('[contenteditable="true"]')
      )
        return;
      // 只短暂增亮难以感知；保持同一组粒子的相位，直接提高播放速率并放大、增强光晕。
      lastInput = performance.now();
      if (frame === undefined) refreshAnimations();
      applyBoost(1);
      if (frame === undefined) frame = requestAnimationFrame(animateInput);
    };
    reset();
    // Lexical 会阻止 input 冒泡，首字符受控插入也可能没有 input；捕获 beforeinput 才覆盖完整键入。
    shell.addEventListener("beforeinput", onInput, true);
    // 粘贴由 Lexical 阻止默认插入，不一定再派发 beforeinput；只观察事件，不读取剪贴板。
    shell.addEventListener("paste", onInput, true);
    reducedMotion.addEventListener("change", reset);
    return () => {
      reset();
      shell.removeEventListener("beforeinput", onInput, true);
      shell.removeEventListener("paste", onInput, true);
      reducedMotion.removeEventListener("change", reset);
    };
  }, [intensity]);

  return (
    <span ref={rootRef} className="composer-model-sparks" aria-hidden="true">
      {SPARKS.map((style, index) => (
        <i
          key={index}
          className="composer-model-spark"
          style={style}
          data-active={index < Math.round(8 + intensity * 16)}
        />
      ))}
    </span>
  );
});
