import { useState } from "react";
import { LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitHistoryController } from "@/hooks/useGitHistory.js";
export function GitHistoryLocate({
  history,
  onShow,
}: {
  history: GitHistoryController;
  onShow: () => void;
}) {
  const [target, setTarget] = useState(""),
    [open, setOpen] = useState(false);
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.history.${key}` });
  const disabled = !history.session.ready || history.session.pending;
  const locate = async () => {
    if (await history.locate(target)) {
      setOpen(false);
      onShow();
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={t("locate")}
          title={t("locate")}
        >
          <LocateFixed className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="space-y-2 rounded-md p-2">
        <p className="text-ui-sm">{t("locateHint")}</p>
        <Input
          aria-label={t("locateTarget")}
          value={target}
          maxLength={1024}
          disabled={disabled}
          className="text-mobile-input-safe md:text-ui-sm"
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              void locate();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={disabled || !target.trim()}
          onClick={() => {
            void locate();
          }}
        >
          {t("locate")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
