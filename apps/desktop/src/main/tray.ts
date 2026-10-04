import { activityEvents } from "@/main/activity";
import { agentDriver } from "@/main/agents/agent-driver";
import { host } from "@/main/host";
import type { TrayItem } from "@/main/host";
import * as store from "@/main/store/store";
import { isOutOfBudget } from "@/shared/domain";
import { earliestReset, napLabel, usageLabel } from "@/shared/format";

// The menu-bar icon is the shell's to draw (a template image, so the system colours it); what it
// says, and what its menu offers, is decided here from the office.

interface OfficeStatus {
  company: ReturnType<typeof store.getCompany>;
  working: number;
  /** Asks and order cards only the founder can settle. */
  waiting: number;
  napUntil: number | undefined;
  active: boolean;
}

const officeStatus = (): OfficeStatus => {
  const company = store.getCompany();
  const working = company ? store.listEmployees().filter((e) => e.status === "working").length : 0;
  const waiting = company
    ? store.listOpenTasks().filter((t) => t.state.kind === "blocked").length
    : 0;
  return {
    active: working > 0 || company?.autopilot === true,
    company,
    napUntil: earliestReset(agentDriver.restingRunners(), Date.now()),
    waiting,
    working,
  };
};

const officeLine = (s: OfficeStatus, company: NonNullable<OfficeStatus["company"]>): string => {
  const usage = usageLabel(company.spentUsd);
  if (s.working > 0) {
    return `${s.working} working · ${usage}`;
  }
  if (s.napUntil !== undefined) {
    return napLabel(s.napUntil);
  }
  return `${company.autopilot ? "idle" : "paused"} · ${usage}`;
};

const statusLine = (s: OfficeStatus): string => {
  if (!s.company) {
    return "No company yet";
  }
  const line = officeLine(s, s.company);
  return s.waiting > 0 ? `✋ ${s.waiting} waiting on you · ${line}` : line;
};

// what waits on the founder leads: a menu-bar-only launch shows nothing else of it
const badge = (s: OfficeStatus, windowless: boolean): string => {
  if (!windowless) {
    return "";
  }
  if (s.waiting > 0) {
    return ` ✋ ${s.waiting}`;
  }
  if (s.working > 0) {
    return ` ● ${s.working}`;
  }
  if (s.napUntil !== undefined) {
    return " ☕";
  }
  return s.active ? " ●" : "";
};

interface TrayHost {
  setAutopilot: (on: boolean) => void;
}

const autopilotItem = (company: NonNullable<OfficeStatus["company"]>): TrayItem => {
  if (company.autopilot) {
    return { enabled: true, kind: "autopilot", label: "Pause the office", on: false };
  }
  return isOutOfBudget(company)
    ? {
        enabled: false,
        kind: "autopilot",
        label: "Out of budget — raise the cap to start",
        on: true,
      }
    : { enabled: true, kind: "autopilot", label: "Start the office", on: true };
};

class AppTray {
  private host: TrayHost | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private windowless = false;

  init(trayHost: TrayHost): void {
    if (this.host) {
      return;
    }
    this.host = trayHost;
    this.rebuild();
    // status decays on its own (resting countdowns, run ends while closed)
    setInterval(() => this.rebuild(), 60_000).unref?.();
    // and reacts to the office: debounce the activity stream into rebuilds
    activityEvents.on("activity", (event) => {
      this.scheduleRebuild();
      if (event.kind === "order.card" && event.payload.open) {
        this.announceCard(event.message);
      }
    });
  }

  /** The menu's autopilot item, clicked: it sets what its label said, whatever has moved since. */
  setAutopilot(on: boolean): void {
    this.host?.setAutopilot(on);
  }

  /** Notify once when the office continues working after its last window closes. */
  setWindowless(windowless: boolean): void {
    if (this.windowless === windowless) {
      return;
    }
    this.windowless = windowless;
    const s = officeStatus();
    if (windowless && s.active) {
      host().notify({
        body: `${statusLine(s)} — your team keeps working in the background. The 💼 in the menu bar has status and Quit.`,
        title: "IdleBiz is still running",
      });
    }
    this.rebuild();
  }

  /** An order card waits on the founder, who may have no window open to see it. */
  private announceCard(title: string): void {
    if (!this.windowless) {
      return;
    }
    host().notify({
      body: `${title} — open IdleBiz to settle it.`,
      title: "An order card is waiting",
    });
  }

  /** Opened at login, into the menu bar: the founder asked for that, so nothing announces it. */
  startWindowless(): void {
    this.windowless = true;
    this.rebuild();
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) {
      return;
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 1500);
    this.rebuildTimer.unref?.();
  }

  private rebuild(): void {
    if (!this.host) {
      return;
    }
    const s = officeStatus();
    host().tray({
      items: [
        { kind: "open", label: `Open ${s.company?.name ?? "IdleBiz"}` },
        { kind: "separator" },
        { kind: "status", label: statusLine(s) },
        ...(s.company ? [autopilotItem(s.company)] : []),
        { kind: "separator" },
        { kind: "quit", label: "Quit IdleBiz" },
      ],
      title: badge(s, this.windowless),
      tooltip: `IdleBiz — ${statusLine(s)}`,
    });
  }
}

export const appTray = new AppTray();
