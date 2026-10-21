import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function ReviewDialogFooter({
  onClose,
  actionSlotRef,
}: {
  onClose: () => void;
  actionSlotRef: (value: HTMLDivElement | null) => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-border bg-panel px-3 py-2"
      data-testid="git-review-footer"
    >
      <Button type="button" variant="ghost" data-testid="git-commit-close" onClick={onClose}>
        {intl.formatMessage({ id: "common.close" })}
      </Button>
      <div
        ref={actionSlotRef}
        className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2"
      />
    </div>
  );
}
