import { useMemo } from "react";
import type { FileDiffOptions } from "@pierre/diffs";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
export function useGitHistoryDiffOptions() {
  const { intl } = useLCodeIntl();
  return useMemo<FileDiffOptions<undefined, undefined>>(
    () => ({
      onPostRender(container, instance, phase) {
        if (phase === "unmount") return;
        const root = container.shadowRoot;
        if (!root) return;
        // 库的默认分隔标签固定英文且展开节点没有键盘入口；仅适配其 UI 标签，保留公开 expandHunk 的真实展开行为。
        for (const label of root.querySelectorAll<HTMLElement>("[data-unmodified-lines]")) {
          const match = /^(\d+)/.exec(label.textContent?.trim() ?? "");
          if (match)
            label.textContent = intl.formatMessage(
              { id: "git.history.unchangedLines" },
              { count: Number(match[1]) },
            );
        }
        for (const button of root.querySelectorAll<HTMLElement>("[data-expand-button]")) {
          const all = button.hasAttribute("data-expand-all-button");
          const direction = button.hasAttribute("data-expand-up")
            ? "up"
            : button.hasAttribute("data-expand-down")
              ? "down"
              : "both";
          const label = intl.formatMessage({ id: `git.history.expand.${all ? "all" : direction}` });
          if (all) button.textContent = label;
          button.setAttribute("aria-label", label);
          button.title = label;
          button.tabIndex = 0;
          button.onkeydown = (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            const index = Number(
              button.closest("[data-expand-index]")?.getAttribute("data-expand-index"),
            );
            if (!Number.isInteger(index)) return;
            event.preventDefault();
            event.stopPropagation();
            instance.expandHunk(index, direction, all ? Number.POSITIVE_INFINITY : undefined);
          };
        }
      },
    }),
    [intl],
  );
}
