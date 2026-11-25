import { readFileSync } from "node:fs";
import path from "node:path";
import { Menu, Tray, app, nativeImage } from "electron";
import { unreachable } from "@repo/domain/errors";
import type { TrayItem } from "idlebiz/host";
import { tellMain } from "./shell";
import { shellLog } from "./shell-log";
import { showWindow } from "./window";

let tray: Tray | null = null;

const iconFile = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "tray.png")
    : path.join(app.getAppPath(), "resources", "tray.png");

const icon = () => {
  const image = nativeImage.createFromBuffer(readFileSync(iconFile()), { scaleFactor: 2 });
  image.setTemplateImage(true);

  return image;
};

const itemOf = (item: TrayItem, index: number) => {
  switch (item.kind) {
    case "open": {
      return { click: showWindow, label: item.label };
    }

    case "status": {
      return { enabled: false, label: item.label };
    }

    case "autopilot": {
      return {
        click: () => {
          tellMain("tray", { on: item.on });
        },
        enabled: item.enabled,
        id: item.on ? "autopilot-on" : "autopilot-off",
        label: item.label,
      };
    }

    case "separator": {
      return { type: "separator" as const };
    }

    case "ask": {
      return {
        click: () => {
          tellMain("inbox", null);
          showWindow();
        },
        id: `ask-${index}`,
        label: item.label,
      };
    }

    case "update": {
      return {
        click: () => {
          tellMain("update", null);
        },
        label: item.label,
      };
    }

    case "quit": {
      return {
        click: () => {
          app.quit();
        },
        label: item.label,
      };
    }

    default: {
      return unreachable(item);
    }
  }
};

/**
 * The menu-bar icon: a template image the system colours, beside the title, tooltip and menu main
 * decides, drawn on main's first model and redrawn on each one after. Open and Quit are the
 * shell's; the autopilot, update and waiting items go to main.
 */
export const drawTray = (model: { items: readonly TrayItem[]; title: string; tooltip: string }) => {
  try {
    tray ??= new Tray(icon());
    tray.setContextMenu(Menu.buildFromTemplate(model.items.map(itemOf)));
    tray.setToolTip(model.tooltip);
    tray.setTitle(model.title);
  } catch (error) {
    shellLog(`could not draw the menu-bar icon: ${String(error)}`);
  }
};
