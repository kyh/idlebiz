import type { LoadSkip } from "@/shared/domain";

export const SaveIssues = ({ issues }: { issues: readonly LoadSkip[] }) => (
  <ul className="space-y-2">
    {issues.map((issue) => (
      <li key={issue.path} className="px-inset p-2 text-xs">
        <div className="truncate text-fg">{issue.path}</div>
        <div className="mt-0.5 text-fg-dim">{issue.error}</div>
      </li>
    ))}
  </ul>
);
