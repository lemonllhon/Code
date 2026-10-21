import { useLayoutEffect, useRef, useState, type UIEvent } from "react";
export function useGitGraphViewport(count: number, rowHeight: number, firstHash?: string) {
  const [element, attach] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 900 });
  const previous = useRef(firstHash);
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [element]);
  useLayoutEffect(() => {
    if (previous.current !== firstHash && element) {
      element.scrollTop = 0;
      setViewport({ top: 0, height: element.clientHeight });
    }
    previous.current = firstHash;
  }, [element, firstHash]);
  const start = Math.max(0, Math.floor((viewport.top - 28) / rowHeight) - 12);
  const end = Math.min(count, Math.ceil((viewport.top + viewport.height) / rowHeight) + 12);
  return {
    attach,
    start,
    end,
    scroll: (event: UIEvent<HTMLDivElement>) =>
      setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight }),
    reveal: (index: number) => {
      if (!element) return;
      const y = index * rowHeight;
      if (y < element.scrollTop || y + rowHeight > element.scrollTop + element.clientHeight - 28) {
        element.scrollTop = y;
        setViewport({ top: element.scrollTop, height: element.clientHeight });
      }
    },
  };
}
