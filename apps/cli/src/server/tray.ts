import { activityEvents } from "./activity";
import { runnerPool } from "./agents/runner-pool";
import { host } from "./host";
import type { TrayItem } from "./host";
import * as store from "./store/store";
import { updateStatus } from "./updates";
import { isOutOfBudget } from "@repo/domain/domain";
import { earliestReset, napLabel, usageLabel } from "@repo/domain/format";

interface OfficeStatus {
  company: ReturnType<typeof store.getCompany>;
  working: number;
  waiting: number;
  napUntil: number | undefined;
  active: boolean;
}

const officeStatus = () => {
  const company = store.getCompany();
  const working = company ? store.listEmployees().filter((e) => e.status === "working").length : 0;

  const waiting = company
    ? store.listOpenTasks().filter((t) => t.state.kind === "blocked").length
    : 0;

  return {
    active: working > 0 || company?.autopilot === true,
    company,
    napUntil: earliestReset(runnerPool.restingRunners(), Date.now()),
    waiting,
    working,
  } satisfies OfficeStatus;
};

const officeLine = (s: OfficeStatus, company: NonNullable<OfficeStatus["company"]>) => {
  const usage = usageLabel(company.spentUsd);

  if (s.working > 0) {
    return `${s.working} working · ${usage}`;
  }

  if (s.napUntil !== undefined) {
    return napLabel(s.napUntil);
  }

  return `${company.autopilot ? "idle" : "paused"} · ${usage}`;
};

const statusLine = (s: OfficeStatus) => {
  if (!s.company) {
    return "No company yet";
  }

  const line = officeLine(s, s.company);

  return s.waiting > 0 ? `✋ ${s.waiting} waiting on you · ${line}` : line;
};

const badge = (s: OfficeStatus, windowless: boolean) => {
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

const autopilotItem = (company: NonNullable<OfficeStatus["company"]>) => {
  if (company.autopilot) {
    return {
      enabled: true,
      kind: "autopilot",
      label: "Pause the office",
      on: false,
    } satisfies TrayItem;
  }

  return (
    isOutOfBudget(company)
      ? {
          enabled: false,
          kind: "autopilot",
          label: "Out of budget — raise the cap to start",
          on: true,
        }
      : { enabled: true, kind: "autopilot", label: "Start the office", on: true }
  ) satisfies TrayItem;
};

class AppTray {
  private started = false;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private windowless = false;

  start() {
    this.started = true;
    this.rebuild();
    setInterval(() => this.rebuild(), 60_000).unref?.();
    activityEvents.on("activity", (event) => {
      this.scheduleRebuild();

      if (event.kind === "order.card" && event.payload.open) {
        this.announceCard(event.message);
      }
    });
  }

  setWindowless(windowless: boolean) {
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

  private announceCard(title: string) {
    if (!this.windowless) {
      return;
    }

    host().notify({
      body: `${title} — open IdleBiz to settle it.`,
      title: "An order card is waiting",
    });
  }

  refresh() {
    this.scheduleRebuild();
  }

  startWindowless() {
    this.windowless = true;
    this.rebuild();
  }

  private scheduleRebuild() {
    if (this.rebuildTimer) {
      return;
    }

    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 1500);
    this.rebuildTimer.unref?.();
  }

  private rebuild() {
    if (!this.started) {
      return;
    }

    const s = officeStatus();
    const update = updateStatus();
    host().tray({
      items: [
        { kind: "open", label: `Open ${s.company?.name ?? "IdleBiz"}` },
        { kind: "separator" },
        { kind: "status", label: statusLine(s) },
        ...(s.company ? [autopilotItem(s.company)] : []),
        { kind: "separator" },
        ...(update.kind === "available"
          ? [{ kind: "update" as const, label: `Update to IdleBiz ${update.version}…` }]
          : []),
        { kind: "quit", label: "Quit IdleBiz" },
      ],
      title: badge(s, this.windowless),
      tooltip: `IdleBiz — ${statusLine(s)}`,
    });
  }
}

export const appTray = new AppTray();
