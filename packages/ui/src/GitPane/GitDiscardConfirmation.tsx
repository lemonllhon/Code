import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitDiscardConfirmation({
  confirmation,
  pending,
  canConfirm,
  onCancel,
  onConfirm,
}: {
  confirmation: { paths: string[]; staged: boolean } | null;
  pending: boolean;
  canConfirm: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <AlertDialog
      open={Boolean(confirmation)}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialogContent data-testid="git-discard-confirmation">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage(
              { id: "git.files.discardTitle" },
              { count: confirmation?.paths.length ?? 0 },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({
              id: confirmation?.staged
                ? "git.files.discardStagedDescription"
                : "git.files.discardDescription",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 min-w-0 overflow-auto rounded-md border border-border p-2 text-ui-sm text-foreground">
          {confirmation?.paths.map((path) => (
            <li key={path} className="break-all py-0.5">
              {path}
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="git-discard-cancel" disabled={pending}>
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <Button
            data-testid="git-discard-confirm"
            variant="destructive"
            disabled={pending || !canConfirm}
            onClick={onConfirm}
          >
            {intl.formatMessage({ id: "git.files.discard" })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
