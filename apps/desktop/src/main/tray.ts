import { Menu, Tray, app, nativeImage } from "electron";
import { RUNNER_IDS } from "@repo/agent-driver/runner";
import { agentDriver } from "@/main/agents/agent-driver";
import { scheduler } from "@/main/scheduler";
import * as store from "@/main/store/store";

// ---------------------------------------------------------------------------
// The menu-bar presence: IdleBiz is a background mac app. Closing the window
// leaves the office running — the tray icon is how you know, see status, and
// get back in. Icon is a 16x16 pixel briefcase, macOS template-style
// (black+alpha, recolored by the system for light/dark menu bars).
// ---------------------------------------------------------------------------

const ICON_1X =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANklEQVQ4jWNgGKzgPw5MkgHo4D+5tv4n1jX/CdlASO1/ahjwn9pe+E9KgP6nhgH/R3gsDAwAAL33R7nFdoDeAAAAAElFTkSuQmCC";
const ICON_2X =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAATElEQVRYhe2SQQoAMAzC+v9PZ0/oChviZsCrBLQqhH0Y5l2BDn8BLsdH4DQRwG4C1CdELdAxLY4AdhOgPiFqgdNEALsJUJ8QlUD4iwV6wR7wcXzNhgAAAABJRU5ErkJggg==";

function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_1X}`);
  img.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${ICON_2X}`,
  });
  img.setTemplateImage(true);
  return img;
}

const fmtTime = (epoch: number): string =>
  new Date(epoch).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** One line of truth for the menu: what is the office doing right now? */
function statusLine(): string {
  const company = store.getDefaultCompany();
  if (!company || !company.onboarded) return "No company yet";
  const working = store.listEmployees(company.id).filter((e) => e.status === "working").length;
  const naps = RUNNER_IDS.map((r) => agentDriver.restingRunner(r)).filter(
    (t): t is number => t !== null,
  );
  const nap = naps.toSorted((a, b) => a - b)[0];
  if (working > 0) return `${working} working · spent $${company.spentUsd.toFixed(2)}`;
  if (nap !== undefined) return `☕ resting til ${fmtTime(nap)}`;
  return company.autopilot
    ? `idle · spent $${company.spentUsd.toFixed(2)}`
    : `paused · spent $${company.spentUsd.toFixed(2)}`;
}

export interface TrayHost {
  /** Show the existing window or create one (also restores the dock icon). */
  openWindow(): void;
  /** Flip autopilot and let the renderer know (if a window is open). */
  setAutopilot(on: boolean): void;
}

class AppTray {
  private tray: Tray | null = null;
  private host: TrayHost | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  init(host: TrayHost): void {
    if (this.tray) return;
    this.host = host;
    this.tray = new Tray(trayIcon());
    this.tray.setToolTip("IdleBiz");
    this.tray.on("double-click", () => host.openWindow());
    this.rebuild();
    // status decays on its own (resting countdowns, run ends while closed)
    setInterval(() => this.rebuild(), 60_000).unref?.();
    // and reacts to the office: debounce the activity stream into rebuilds
    scheduler.events.on("activity", () => this.scheduleRebuild());
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 1_500);
    this.rebuildTimer.unref?.();
  }

  private rebuild(): void {
    const tray = this.tray;
    const host = this.host;
    if (!tray || !host) return;
    const company = store.getDefaultCompany();
    const autopilot = company?.autopilot ?? false;
    const menu = Menu.buildFromTemplate([
      { label: `Open ${company?.name ?? "IdleBiz"}`, click: () => host.openWindow() },
      { type: "separator" },
      { label: statusLine(), enabled: false },
      ...(company && company.onboarded
        ? [
            {
              label: autopilot ? "Pause the office" : "Start the office",
              click: (): void => host.setAutopilot(!autopilot),
            },
          ]
        : []),
      { type: "separator" },
      { label: "Quit IdleBiz", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`IdleBiz — ${statusLine()}`);
  }
}

export const appTray = new AppTray();
