import { useRef } from "react";
import { CopyIcon, LoaderIcon, SparklesIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { commitSubjectLength, insertConventionalType } from "./commitDraft.js";

export function GitCommitMessageEditor({
  message,
  previousMessage,
  disabled,
  generationPending,
  canGenerate,
  onMessageChange,
  onGenerate,
  onCopy,
  onRestore,
}: {
  message: string;
  previousMessage: string | null;
  disabled: boolean;
  generationPending: boolean;
  canGenerate: boolean;
  onMessageChange: (message: string) => void;
  onGenerate: () => void;
  onCopy: () => void;
  onRestore: () => void;
}) {
  const { intl } = useLCodeIntl();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const length = commitSubjectLength(message);
  const generateLabel = intl.formatMessage({
    id: message.trim()
      ? "git.actionMenu.commitDialog.regenerate"
      : "git.actionMenu.commitDialog.generate",
  });
  return (
    <div className="min-w-0 space-y-1 px-3 pb-2">
      <div className="flex h-7 items-center gap-1">
        <label
          htmlFor="git-action-menu-commit-message"
          className="min-w-0 flex-1 text-ui-sm font-medium"
        >
          {intl.formatMessage({ id: "git.actionMenu.commitDialog.messageLabel" })}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-foreground-subtle"
          data-testid="git-commit-generate-button"
          aria-label={generateLabel}
          title={generateLabel}
          disabled={disabled || !canGenerate}
          onClick={onGenerate}
        >
          {generationPending ? (
            <LoaderIcon className="size-4 animate-spin" />
          ) : (
            <SparklesIcon className="size-4" />
          )}
        </Button>
      </div>
      <div className="relative">
        <Textarea
          ref={textareaRef}
          id="git-action-menu-commit-message"
          data-testid="git-commit-message-input"
          value={message}
          disabled={disabled}
          placeholder={intl.formatMessage({ id: "git.actionMenu.commitDialog.messagePlaceholder" })}
          className="field-sizing-fixed min-h-24 w-full resize-y rounded-sm border-border bg-transparent px-2 py-1.5 text-mobile-input-safe shadow-none md:text-ui-base"
          onChange={(event) => onMessageChange(event.target.value)}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span
          data-testid="git-message-subject-length"
          className={length > 72 ? "text-ui-sm text-warning" : "text-ui-sm text-foreground-subtle"}
        >
          {length}/72
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            data-testid="git-message-copy"
            variant="ghost"
            size="icon-xs"
            aria-label={intl.formatMessage({ id: "git.message.copy" })}
            title={intl.formatMessage({ id: "git.message.copy" })}
            disabled={!message}
            onClick={onCopy}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            data-testid="git-message-restore"
            variant="ghost"
            size="icon-xs"
            aria-label={intl.formatMessage({ id: "git.message.restore" })}
            title={intl.formatMessage({ id: "git.message.restore" })}
            disabled={disabled || previousMessage === null}
            onClick={onRestore}
          >
            <Undo2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div
        className="flex flex-wrap gap-1"
        aria-label={intl.formatMessage({ id: "git.message.types" })}
      >
        {["feat", "fix", "docs", "refactor", "test", "chore"].map((type) => (
          <Button
            key={type}
            type="button"
            variant="ghost"
            size="xs"
            className="px-1.5 font-mono text-ui-xs text-foreground-subtle"
            data-testid={`git-message-type-${type}`}
            disabled={disabled}
            onClick={() => onMessageChange(insertConventionalType(message, type))}
          >
            {type}
          </Button>
        ))}
      </div>
    </div>
  );
}
