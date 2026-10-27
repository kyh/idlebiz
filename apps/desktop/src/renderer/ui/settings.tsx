import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, orpc } from "@/renderer/api";
import { useSubmission } from "@/renderer/hooks/use-submission";
import { setAnswer, useCompany, useSaveIssues } from "@/renderer/state/queries";
import { setMaxAgents } from "@/renderer/state/store";
import { Failure } from "@/renderer/ui/failure";
import { Modal } from "@/renderer/ui/modal";
import { Picker } from "@/renderer/ui/picker";
import type { PickerOption } from "@/renderer/ui/picker";
import { SaveIssues } from "@/renderer/ui/save-issues";
import { MAX_AGENTS, MaxAgentsSchema } from "@repo/domain/domain";
import type { LaunchAtLogin } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";

const LOGIN_CHOICES: readonly PickerOption<"off" | "on">[] = [
  { label: "Off", value: "off" },
  { label: "On", value: "on" },
];

// Registered but switched off, or never registered: neither choice is pressed, so Off can
// still take the registration away.
const LOGIN_PRESSED: Record<Exclude<LaunchAtLogin, "unavailable">, "off" | "on" | null> = {
  "not-found": null,
  off: "off",
  on: "on",
  "requires-approval": null,
};

const LOGIN_LINES: Record<LaunchAtLogin, string> = {
  "not-found":
    "macOS could not register IdleBiz. Add it under System Settings → General → Login Items.",
  off: "IdleBiz opens only when you open it.",
  on: "IdleBiz starts in the menu bar when you log in, and the office picks up where it left off.",
  "requires-approval":
    "IdleBiz is switched off under System Settings → General → Login Items. Only you can switch it back on there.",
  unavailable: "Only the installed app can open at login.",
};

// read again each time Settings opens: System Settings can switch the login item meanwhile
const launchAtLogin = orpc.app.launchAtLogin.queryOptions({ staleTime: 0 });

const LaunchAtLoginSetting = () => {
  const { data: state, error } = useQuery(launchAtLogin);
  const setting = useSubmission(async (on: boolean) => {
    await setAnswer(launchAtLogin.queryKey, await api.app.setLaunchAtLogin({ on }));
  });

  return (
    <div className="px-inset p-3 text-sm text-fg">
      <div className="px-label text-fg-dim">Open at login</div>
      {state === undefined && error !== null ? (
        <div role="alert" className="mt-1 text-xs text-danger">
          Could not read the login item: {errorMessage(error)}
        </div>
      ) : null}
      {state === undefined ? null : (
        <>
          <div className="mt-1 text-xs text-fg-dim">{LOGIN_LINES[state]}</div>
          {state === "unavailable" ? null : (
            <Picker
              options={LOGIN_CHOICES}
              value={LOGIN_PRESSED[state]}
              onChange={(choice) => setting.submit(choice === "on")}
              disabled={setting.submission.kind === "sending"}
              label="Open at login"
              className="mt-2 grid grid-cols-2 gap-2"
            />
          )}
        </>
      )}
      <Failure submission={setting.submission} doing="change the login item" />
    </div>
  );
};

export const Settings = ({ onClose }: { onClose: () => void }) => {
  const company = useCompany();
  const saveIssues = useSaveIssues();
  const [confirm, setConfirm] = useState("");
  const [cap, setCap] = useState<string | null>(null);
  const savingCap = useSubmission(async (n: number) => {
    await setMaxAgents(n);
    setCap(null);
  });
  const resetting = useSubmission(() => api.save.reset());

  if (!company) {
    return null;
  }
  const armed = confirm.trim() === company.name;
  const capValue = cap ?? String(company.maxAgents);
  const parsedCap = MaxAgentsSchema.safeParse(Number(capValue));
  const newCap = parsedCap.success && parsedCap.data !== company.maxAgents ? parsedCap.data : null;
  const demolishing =
    resetting.submission.kind === "sending" || resetting.submission.kind === "sent";

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="space-y-4">
        <div className="px-inset p-3 text-sm text-fg">
          <div className="px-label text-fg-dim">Company</div>
          <div className="mt-1">{company.name}</div>
          {company.mission === null ? null : (
            <div className="text-xs text-fg-dim">{company.mission}</div>
          )}
          <div className="mt-1 truncate text-xs text-fg-dim select-text">
            {company.workspaceDir}
          </div>
        </div>

        {saveIssues.length > 0 ? (
          <div className="px-inset p-3 text-sm text-fg">
            <div className="px-label text-danger">Skipped at boot</div>
            <div className="mt-1 text-xs text-fg-dim">
              Boot could not use these and went on without them. Fix them and relaunch.
            </div>
            <div className="mt-2">
              <SaveIssues issues={saveIssues} />
            </div>
          </div>
        ) : null}

        <div className="px-inset p-3 text-sm text-fg">
          <div className="px-label text-fg-dim">Team size cap</div>
          <div className="mt-1 text-xs text-fg-dim">
            The team lead hires and releases on their own — this is the hard ceiling, up to{" "}
            {MAX_AGENTS}.
          </div>
          <div className="mt-2 flex gap-2">
            <input
              aria-label="Team size cap"
              value={capValue}
              onChange={(e) => setCap(e.target.value)}
              inputMode="numeric"
              className="px-field w-20"
            />
            <button
              type="button"
              onClick={() => {
                if (newCap !== null) {
                  savingCap.submit(newCap);
                }
              }}
              disabled={newCap === null || savingCap.submission.kind === "sending"}
              className="px-btn"
            >
              Save
            </button>
          </div>
          <Failure submission={savingCap.submission} doing="save the cap" />
        </div>

        <LaunchAtLoginSetting />

        <div className="px-inset p-3 text-sm text-fg">
          <div className="px-label text-fg-dim">Controls</div>
          <div className="mt-1 text-xs text-fg-dim">
            WASD / arrows to move · walk up to someone and press E
          </div>
          <div className="mt-1 text-xs text-fg-dim">
            Closing this window keeps the office running — the 💼 in the menu bar shows status and
            is where you quit.
          </div>
        </div>

        <div className="px-inset px-inset-danger p-3">
          <div className="px-label text-danger">Danger zone</div>
          <div className="mt-1 text-sm leading-snug text-fg">
            Reset demolishes the office: every employee, task, and workspace file your team created,
            plus stored secrets and connections. Its live payment links are switched off at Stripe
            first; any Stripe would not switch off, and paid prints not yet at Printful, are listed
            for you to handle by hand. The game restarts from scratch. There is no undo.
          </div>
          {demolishing ? (
            <div className="px-live-dot mt-3 text-sm text-danger">Demolishing the office…</div>
          ) : (
            <>
              <div className="mt-3 flex gap-2">
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={`Type "${company.name}" to confirm`}
                  className="px-field min-w-0 flex-1"
                />
                <button
                  type="button"
                  onClick={() => resetting.submit()}
                  disabled={!armed}
                  className="px-btn"
                  style={armed ? { background: "var(--danger)", color: "var(--light)" } : undefined}
                >
                  Reset everything
                </button>
              </div>
              <Failure submission={resetting.submission} doing="reset" />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};
