import { packageFile } from "../../paths";

// sharp reads real files: the sheets are this package's own, in the .app or the checkout.
export const employeeSheetDir = (): string => packageFile("resources/employee-sheets");
