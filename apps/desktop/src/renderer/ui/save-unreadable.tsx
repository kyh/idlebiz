import { AlertDialog } from "@base-ui/react/alert-dialog";
import { api } from "@/renderer/api";
import { Curtain } from "@/renderer/ui/curtain";
import { SaveIssues } from "@/renderer/ui/save-issues";
import type { LoadSkip } from "@repo/domain/domain";

// No onboarding here: founding refuses while the save's folder is there.
// A save only a newer build can read must be left as it is: editing or moving it
// loses what that build added, so it gets no Fix-or-move advice and no folder button.
export const SaveUnreadable = ({ issues }: { issues: LoadSkip[] }) => {
  const newer = issues.every((issue) => issue.newerBuild);
  return (
    <Curtain>
      <AlertDialog.Title className="text-base text-fg">
        {newer ? "Your save is from a newer IdleBiz" : "Your save can't be read"}
      </AlertDialog.Title>
      <AlertDialog.Description className="mt-1 text-sm leading-relaxed text-fg-dim">
        {newer
          ? "Update IdleBiz to open it. Leave the save folder as it is: editing or moving it would lose what the newer version added."
          : "The company folder under ~/.idlebiz holds no COMPANY.md this build can read. Fix or move it, then relaunch."}
      </AlertDialog.Description>
      <div className="mt-3">
        <SaveIssues issues={issues} />
      </div>
      {newer ? null : (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => {
              void api.save.openFolder();
            }}
            className="px-btn-accent px-btn"
          >
            Open save folder
          </button>
        </div>
      )}
    </Curtain>
  );
};
