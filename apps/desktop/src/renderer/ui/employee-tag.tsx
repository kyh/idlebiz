import { StatusBadge } from "@/renderer/ui/status-badge";
import type { EmployeeStatus } from "@/shared/domain";

/** Name, job title and, where it matters, whether they are working right now. */
export const EmployeeTag = ({
  name,
  title,
  lead = false,
  status,
  size = "sm",
}: {
  name: string;
  title: string;
  lead?: boolean;
  status?: EmployeeStatus;
  size?: "sm" | "lg";
}) => (
  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
    <span
      className={size === "lg" ? "text-base uppercase tracking-wide text-fg" : "text-sm text-fg"}
    >
      {lead ? <span className="text-[#c9a227]">★ </span> : null}
      {name}
    </span>
    <span className="text-xs text-accent-lo">{title}</span>
    {status ? <StatusBadge status={status} /> : null}
  </span>
);
