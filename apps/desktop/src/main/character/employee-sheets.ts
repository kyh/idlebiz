import path from "node:path";
import { launch } from "@/main/host";

// sharp reads real files: the sheets sit in the bundle's resources, or the checkout's.
export const employeeSheetDir = (): string => path.join(launch().resourcesDir, "employee-sheets");
