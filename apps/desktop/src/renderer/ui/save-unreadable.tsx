import { openSaveFolder } from "@/renderer/state/store";
import { useModal } from "@/renderer/ui/modal";
import type { LoadSkip } from "@/shared/ipc-registry";

/**
 * A company exists on disk and could not be read. Shown instead of onboarding:
 * offering a fresh start here would stack a second company on the one the
 * founder has, and the file is theirs to fix.
 */
export function SaveUnreadable({ issues }: { issues: LoadSkip[] }) {
  useModal();
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-6">
      <div className="px-battle w-full max-w-lg p-4">
        <div className="text-base text-fg">Your save can't be read</div>
        <div className="mt-1 text-sm leading-relaxed text-fg-dim">
          A company folder under ~/.idlebiz exists, but its file did not parse. Fix or move it, then
          relaunch. Starting over from here would create a second company on top of it.
        </div>
        <ul className="mt-3 space-y-2">
          {issues.map((issue) => (
            <li key={issue.path} className="px-inset p-2 text-xs">
              <div className="truncate text-fg">{issue.path}</div>
              <div className="mt-0.5 text-fg-dim">{issue.error}</div>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void openSaveFolder()}
            className="px-btn-accent px-btn"
          >
            Open save folder
          </button>
        </div>
      </div>
    </div>
  );
}
