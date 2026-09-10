import type { EmployeeStatus } from "@/shared/domain";
import { cn } from "cn";

/** Working or idle, in the colours the HUD uses for the same words. */
export const StatusBadge = ({ status }: { status: EmployeeStatus }) => (
  <span className={cn("px-badge inline-block", status === "working" ? "px-hot" : "px-quiet")}>
    {status === "working" ? <span className="px-live-dot">● working</span> : "idle"}
  </span>
);
