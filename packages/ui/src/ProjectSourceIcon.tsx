import { Cloud, Folder, type LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProjectSourceKind } from "@/workspaceProjectMenu.js";

export function ProjectSourceIcon({
  kind,
  localIcon = Folder,
  className,
}: {
  kind: ProjectSourceKind;
  localIcon?: LucideIcon;
  className?: string;
}) {
  const { intl } = useLCodeIntl();
  const label = intl.formatMessage({ id: `project.source.${kind}` });
  const LocalIcon = kind === "mixed" ? Folder : localIcon;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-project-source={kind}
      className={cn("inline-flex shrink-0 items-center gap-1 text-foreground-subtle", className)}
    >
      {kind !== "remote" ? <LocalIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
      {kind !== "local" ? <Cloud aria-hidden="true" className="size-4 shrink-0" /> : null}
    </span>
  );
}
