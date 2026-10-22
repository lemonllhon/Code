import type { ComponentProps } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { ProjectMemberRow } from "./ProjectMemberRow.js";
import { useProjectEditorText } from "./projectEditorText.js";

export function ProjectSortableMember({
  sortable,
  ...props
}: ComponentProps<typeof ProjectMemberRow> & { sortable: boolean }) {
  const text = useProjectEditorText();
  const sort = useSortable({
    id: props.member.id,
    disabled: !sortable || props.disabled || props.primary,
  });
  return (
    <div
      ref={sort.setNodeRef}
      className="relative min-w-0"
      style={{
        transform: CSS.Transform.toString(sort.transform),
        transition: sort.transition,
        zIndex: sort.isDragging ? 1 : undefined,
        opacity: sort.isDragging ? 0.7 : undefined,
      }}
    >
      <ProjectMemberRow
        {...props}
        sortHandle={
          sortable ? (
            <button
              type="button"
              ref={sort.setActivatorNodeRef}
              {...sort.attributes}
              {...sort.listeners}
              data-project-sort-handle={props.member.id}
              data-dragging={sort.isDragging}
              disabled={props.disabled || props.primary}
              aria-label={`${props.member.path} · ${text("reorder")}`}
              title={props.primary ? text("primaryFirstHint") : text("reorder")}
              className="flex size-5 shrink-0 touch-none items-center justify-center rounded cursor-grab text-foreground-subtlest hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:cursor-default disabled:opacity-40 active:cursor-grabbing"
            >
              <GripVertical className="size-3.5" aria-hidden="true" />
            </button>
          ) : undefined
        }
      />
    </div>
  );
}
