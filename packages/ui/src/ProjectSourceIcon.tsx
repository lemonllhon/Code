import { Cloud, Folder, createLucideIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProjectSourceKind } from "@/workspaceProjectMenu.js";

// 中文依据：混合来源需要同时可辨认，但只占一个图标位；文件夹与云共用同一个 SVG 轮廓。
const MixedProjectIcon = createLucideIcon("FolderCloud", [
  ["path", { d: "M8 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h10a2 2 0 0 1 2 2v2", key: "folder" }],
  ["path", { d: "M19 20a3 3 0 1 0-.4-6 4 4 0 0 0-7.6 1 2.5 2.5 0 0 0 .5 5Z", key: "cloud" }],
]);

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
  const Icon = kind === "mixed" ? MixedProjectIcon : kind === "remote" ? Cloud : localIcon;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-project-source={kind}
      className={cn("inline-flex shrink-0 items-center text-foreground-subtle", className)}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
    </span>
  );
}
