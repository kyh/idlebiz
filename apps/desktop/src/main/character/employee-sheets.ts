import path from "node:path";
import { app } from "electron";

// sharp needs real files: packaged sheets live in electron-builder's extraResources.
export const employeeSheetDir = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "employee-sheets")
    : path.join(app.getAppPath(), "resources", "employee-sheets");
