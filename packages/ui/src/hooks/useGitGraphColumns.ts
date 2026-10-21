import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
const defaults = { date: 104, author: 96, commit: 64 };
type Column = keyof typeof defaults;
export function useGitGraphColumns() {
  const [widths, setWidths] = useState(defaults);
  const drag = useRef<{ column: Column; x: number; width: number; pointer: number } | null>(null);
  const bounds = (column: Column) => (column === "commit" ? [56, 180] : [64, 300]);
  const resize = (column: Column, width: number) => {
    const [min, max] = bounds(column);
    setWidths((old) => ({ ...old, [column]: Math.max(min!, Math.min(max!, width)) }));
  };
  return {
    style: Object.fromEntries(
      Object.entries(widths).map(([column, width]) => [`--git-${column}-width`, `${width}px`]),
    ) as CSSProperties,
    handles: (column: Column) => ({
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical" as const,
      "aria-valuemin": bounds(column)[0],
      "aria-valuemax": bounds(column)[1],
      "aria-valuenow": widths[column],
      onDoubleClick: () => resize(column, defaults[column]),
      onPointerDown: (event: PointerEvent<HTMLSpanElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          column,
          x: event.clientX,
          width: widths[column],
          pointer: event.pointerId,
        };
      },
      onPointerMove: (event: PointerEvent<HTMLSpanElement>) => {
        const value = drag.current;
        if (value && value.pointer === event.pointerId)
          resize(value.column, value.width + event.clientX - value.x);
      },
      onPointerUp: (event: PointerEvent<HTMLSpanElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        drag.current = null;
      },
      onLostPointerCapture: () => {
        drag.current = null;
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        resize(
          column,
          event.key === "Home"
            ? defaults[column]
            : widths[column] + (event.key === "ArrowLeft" ? -8 : 8),
        );
      },
    }),
  };
}
