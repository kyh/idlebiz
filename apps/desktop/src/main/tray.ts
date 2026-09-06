import { Menu, Notification, Tray, app, nativeImage } from "electron";
import { activityEvents } from "@/main/activity";
import { agentDriver } from "@/main/agents/agent-driver";
import * as store from "@/main/store/store";
import { earliestReset, napLabel, spentLabel } from "@/shared/format";

// macOS template images use black and alpha; the system recolors them for the menu bar.

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

interface OfficeStatus {
  company: ReturnType<typeof store.getDefaultCompany>;
  working: number;
  napUntil: number | undefined;
  active: boolean;
}

function officeStatus(): OfficeStatus {
  const company = store.getDefaultCompany();
  const working = company
    ? store.listEmployees(company.id).filter((e) => e.status === "working").length
    : 0;
  return {
    company,
    working,
    napUntil: earliestReset(agentDriver.restingRunners(), Date.now()),
    active: working > 0 || company?.autopilot === true,
  };
}

function statusLine(s: OfficeStatus): string {
  if (!s.company) return "No company yet";
  const spent = spentLabel(s.company.spentUsd);
  if (s.working > 0) return `${s.working} working · ${spent}`;
  if (s.napUntil !== undefined) return napLabel(s.napUntil);
  return `${s.company.autopilot ? "idle" : "paused"} · ${spent}`;
}

function badge(s: OfficeStatus, windowless: boolean): string {
  if (!windowless) return "";
  if (s.working > 0) return ` ● ${s.working}`;
  if (s.napUntil !== undefined) return " ☕";
  return s.active ? " ●" : "";
}

interface TrayHost {
  openWindow(): void;
  setAutopilot(on: boolean): void;
}

class AppTray {
  private tray: Tray | null = null;
  private host: TrayHost | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private windowless = false;

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
    activityEvents.on("activity", () => this.scheduleRebuild());
  }

  /** Notify once when the office continues working after its last window closes. */
  setWindowless(windowless: boolean): void {
    if (this.windowless === windowless) return;
    this.windowless = windowless;
    const s = officeStatus();
    if (windowless && s.active && Notification.isSupported()) {
      new Notification({
        title: "IdleBiz is still running",
        body: `${statusLine(s)} — your team keeps working in the background. The 💼 in the menu bar has status and Quit.`,
        silent: true,
      }).show();
    }
    this.rebuild();
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
    const s = officeStatus();
    const autopilot = s.company?.autopilot ?? false;
    const menu = Menu.buildFromTemplate([
      { label: `Open ${s.company?.name ?? "IdleBiz"}`, click: () => host.openWindow() },
      { type: "separator" },
      { label: statusLine(s), enabled: false },
      ...(s.company
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
    tray.setToolTip(`IdleBiz — ${statusLine(s)}`);
    tray.setTitle(badge(s, this.windowless), { fontType: "monospacedDigit" });
  }
}

export const appTray = new AppTray();
