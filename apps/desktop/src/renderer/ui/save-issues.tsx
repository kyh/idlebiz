import type { LoadSkip } from "@/shared/ipc-registry";

/** The files under ~/.idlebiz boot could not read, path over reason. */
export function SaveIssues({ issues }: { issues: readonly LoadSkip[] }) {
  return (
    <ul className="space-y-2">
      {issues.map((issue) => (
        <li key={issue.path} className="px-inset p-2 text-xs">
          <div className="truncate text-fg">{issue.path}</div>
          <div className="mt-0.5 text-fg-dim">{issue.error}</div>
        </li>
      ))}
    </ul>
  );
}
