import { MinusIcon, XIcon } from "lucide-react";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export type RemoteWizardStep = "settings" | "connecting" | "directory";

export function RemoteConnectionWizardHeader({
  title,
  description,
  onMinimize,
  onClose,
}: {
  title: string;
  description: string;
  onMinimize?: () => void;
  onClose?: () => void;
}) {
  const { intl } = useLCodeIntl();

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <DialogTitle className="text-ui-lg font-medium">{title}</DialogTitle>
        <div className="flex shrink-0 items-center gap-1">
          {onMinimize ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={onMinimize}
            >
              <MinusIcon className="size-4" />
              <span className="sr-only">{intl.formatMessage({ id: "remote.minimize" })}</span>
            </Button>
          ) : null}
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={onClose}
            >
              <XIcon className="size-4" />
              <span className="sr-only">{intl.formatMessage({ id: "common.close" })}</span>
            </Button>
          ) : null}
        </div>
      </div>
      <DialogDescription>{description}</DialogDescription>
    </div>
  );
}
