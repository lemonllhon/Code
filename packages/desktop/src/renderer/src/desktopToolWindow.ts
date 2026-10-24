import type { IPlatformService } from "@lcode/shared";

export const openDesktopToolWindow: NonNullable<IPlatformService["openToolWindow"]> = ({
  id,
  width,
  height,
  left,
  top,
}) => {
  const child = window.open(
    "about:blank",
    `lcode-tool-${id}`,
    `popup=yes,width=${Math.round(width)},height=${Math.round(height)}` +
      (left === undefined ? "" : `,left=${Math.round(left)}`) +
      (top === undefined ? "" : `,top=${Math.round(top)}`),
  );
  if (!child) return null;
  return {
    document: child.document,
    focus: () => child.focus(),
    close: () => window.lcode.closeToolWindow(id),
    onCloseRequested: (handler) => {
      // 原生 close 由 Main 阻止并转发，避免 beforeunload 触发浏览器确认框。
      child.addEventListener("lcode-tool-window-close-requested", handler);
      return () => child.removeEventListener("lcode-tool-window-close-requested", handler);
    },
  };
};
