import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command.js";
import type { GitHistoryController } from "@/hooks/useGitHistory.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitHistoryCandidatePicker({
  history,
  kind,
  onSelect,
}: {
  history: GitHistoryController;
  kind: "ref" | "author";
  onSelect: (value: string) => void;
}) {
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.history.${key}` });
  const [open, setOpen] = useState(false);
  const candidates = history.candidates;
  const values =
    kind === "ref"
      ? candidates?.refs.map((ref) => ({ value: ref.value, label: `${ref.label} · ${ref.value}` }))
      : candidates?.authors.map((author) => ({
          value: author.value,
          label: `${author.name} <${author.email}>`,
        }));
  const limited =
    candidates &&
    (kind === "ref"
      ? candidates.refsTruncated
      : candidates.authorsTruncated || candidates.historyTruncated);
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value && !candidates) void history.loadCandidates();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          role="combobox"
          aria-expanded={open}
          disabled={!history.session.ready || history.session.pending}
          aria-label={t(kind === "ref" ? "chooseRef" : "chooseAuthor")}
          title={t(kind === "ref" ? "chooseRef" : "chooseAuthor")}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="gap-1 rounded-md p-1" align="start">
        <Command>
          <CommandInput
            placeholder={t("candidateSearch")}
            aria-label={t("candidateSearch")}
            className="text-mobile-input-safe md:text-ui-sm"
          />
          <CommandList>
            <CommandEmpty>
              {history.session.pending ? t("candidateLoading") : t("candidateEmpty")}
            </CommandEmpty>
            {values?.map((item) => (
              <CommandItem
                key={item.value}
                value={item.label}
                disabled={history.session.pending}
                onSelect={() => {
                  onSelect(item.value);
                  setOpen(false);
                }}
                className="rounded-sm text-ui-sm"
              >
                <span className="min-w-0 truncate" title={item.label}>
                  {item.label}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        {limited ? (
          <p className="px-2 py-1 text-ui-xs text-foreground-subtle">{t("candidateLimited")}</p>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={history.session.pending}
          onClick={() => {
            void history.loadCandidates();
          }}
        >
          {t("candidateRefresh")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
