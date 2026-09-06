import { openSaveFolder } from "@/renderer/state/store";
import { Curtain } from "@/renderer/ui/curtain";
import { SaveIssues } from "@/renderer/ui/save-issues";
import type { LoadSkip } from "@/shared/ipc-registry";

/**
 * A company exists on disk and could not be read. Shown instead of onboarding:
 * offering a fresh start here would stack a second company on the one the
 * founder has, and the file is theirs to fix.
 */
export function SaveUnreadable({ issues }: { issues: LoadSkip[] }) {
  return (
    <Curtain>
      <div className="text-base text-fg">Your save can't be read</div>
      <div className="mt-1 text-sm leading-relaxed text-fg-dim">
        A company folder under ~/.idlebiz exists, but its file did not parse. Fix or move it, then
        relaunch. Starting over from here would create a second company on top of it.
      </div>
      <div className="mt-3">
        <SaveIssues issues={issues} />
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => void openSaveFolder()}
          className="px-btn-accent px-btn"
        >
          Open save folder
        </button>
      </div>
    </Curtain>
  );
}
