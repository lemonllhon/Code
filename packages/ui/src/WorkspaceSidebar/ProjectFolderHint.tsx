import { useEffect, useRef } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useProjectEditorText } from "./projectEditorText.js";

export function ProjectFolderHint() {
  const text = useProjectEditorText();
  const viewport = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation | null>(null);
  const summary = text("folderHint");
  useEffect(() => {
    const container = viewport.current,
      track = content.current;
    if (!container || !track) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      animation.current?.cancel();
      animation.current = null;
      const distance = track.scrollWidth - container.clientWidth;
      if (distance <= 0 || motion.matches) return;
      // 说明只在真实溢出时滚动；悬停/聚焦暂停，让完整提示可读，不干预列表或草稿。
      animation.current = track.animate(
        [
          { transform: "translateX(0)", offset: 0 },
          { transform: "translateX(0)", offset: 0.12 },
          { transform: `translateX(-${distance}px)`, offset: 0.8 },
          { transform: `translateX(-${distance}px)`, offset: 1 },
        ],
        {
          duration: Math.max(8000, distance * 45),
          iterations: Infinity,
          direction: "alternate",
          easing: "linear",
        },
      );
      if (container.matches(":hover, :focus-visible")) animation.current.pause();
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(track);
    motion.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", update);
      animation.current?.cancel();
    };
  }, [summary]);
  const resume = () => {
    if (!viewport.current?.matches(":hover, :focus-visible")) animation.current?.play();
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={viewport}
          type="button"
          data-testid="project-folder-hint"
          className="min-w-0 overflow-hidden text-left text-ui-sm text-foreground-subtlest outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          aria-label={text("folderHintFull")}
          onMouseEnter={() => animation.current?.pause()}
          onMouseLeave={resume}
          onFocus={() => animation.current?.pause()}
          onBlur={resume}
        >
          <span ref={content} className="inline-block whitespace-nowrap">
            {summary}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm whitespace-pre-wrap">
        {text("folderHintFull")}
      </TooltipContent>
    </Tooltip>
  );
}
