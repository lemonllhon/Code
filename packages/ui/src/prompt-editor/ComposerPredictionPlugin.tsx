import { useCallback, useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

/** 灰字是 DOM overlay；只有明确接受才走原 Lexical -> onChange 草稿路径。 */
export function ComposerPredictionPlugin({
  text,
  disabled,
  onDismiss,
}: {
  text?: string;
  disabled?: boolean;
  onDismiss?: () => void;
}) {
  const [editor] = useLexicalComposerContext();
  const { intl } = useLCodeIntl();
  const [empty, setEmpty] = useState(true);
  const acceptInUpdate = useCallback(() => {
    if (!text || disabled || editor.isComposing()) return false;
    const root = $getRoot();
    const selection = $getSelection();
    if (
      root.getTextContentSize() ||
      (selection && (!$isRangeSelection(selection) || !selection.isCollapsed()))
    )
      return false;
    root.clear();
    root.append($createParagraphNode().append($createTextNode(text)));
    root.getLastChild()?.selectEnd();
    return true;
  }, [disabled, editor, text]);
  const accept = useCallback(() => {
    let accepted = false;
    editor.update(
      () => {
        accepted = acceptInUpdate();
      },
      { discrete: true },
    );
    if (accepted) onDismiss?.();
    return accepted;
  }, [acceptInUpdate, editor, onDismiss]);
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const isEmpty = $getRoot().getTextContentSize() === 0;
          setEmpty(isEmpty);
          if (!isEmpty && text) onDismiss?.();
        });
      }),
    [editor, onDismiss, text],
  );
  useEffect(() => {
    const tab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        // command 已在 Lexical update 内；再次 editor.update 会延后执行，布尔值仍为 false，
        // 导致文字插入但 Tab 默认行为又移走焦点。同步修改当前 update 后立即阻止默认 Tab。
        if (
          event.shiftKey ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.isComposing ||
          !acceptInUpdate()
        )
          return false;
        event.preventDefault();
        onDismiss?.();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
    const escape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        if (!text || disabled || editor.isComposing() || event.isComposing) return false;
        onDismiss?.();
        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
    return () => {
      tab();
      escape();
    };
  }, [acceptInUpdate, disabled, editor, onDismiss, text]);
  useEffect(() => {
    const hide = () => onDismiss?.();
    const unregister = editor.registerRootListener((root, previousRoot) => {
      previousRoot?.removeEventListener("compositionstart", hide);
      root?.addEventListener("compositionstart", hide);
    });
    return () => {
      unregister();
      editor.getRootElement()?.removeEventListener("compositionstart", hide);
    };
  }, [editor, onDismiss]);
  if (!text || disabled || !empty) return null;
  return (
    <div
      data-testid="composer-prediction"
      // 整层按钮曾把普通聚焦点击当成接受，并挡住编辑器；正文与提示必须让指针穿透。
      className="pointer-events-none absolute inset-x-0 top-0 flex min-h-10 items-start gap-2 text-left text-ui-base [@media(hover:none)_and_(pointer:coarse)]:text-mobile-input-safe leading-5 text-foreground-subtle"
    >
      <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap">{text}</span>
      <kbd
        aria-hidden="true"
        className="shrink-0 rounded border border-border px-1 text-ui-xs [@media(pointer:coarse)]:hidden"
      >
        Tab
      </kbd>
      <button
        type="button"
        data-testid="composer-prediction-accept"
        aria-label={`${intl.formatMessage({ id: "chat.composer.predictionAccept" })}: ${text}`}
        className="pointer-events-auto hidden min-h-10 shrink-0 items-center rounded border border-border px-2 text-ui-xs outline-none focus-visible:ring-2 focus-visible:ring-border-hover [@media(pointer:coarse)]:inline-flex"
        onPointerDown={(event) => event.preventDefault()}
        onClick={accept}
      >
        {intl.formatMessage({ id: "chat.composer.predictionAccept" })}
      </button>
    </div>
  );
}
