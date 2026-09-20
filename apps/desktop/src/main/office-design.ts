import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { atomicWrite, readJsonFile } from "@/main/lib/fs";
import { OFFICE_DESIGN_PATH } from "@/main/paths";
import { jsonValueSchema, parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import { layoutIssues } from "@/shared/office-grid";
import { canonicalOfficeLayout, parseOfficeLayout } from "@/shared/office-layout-schema";

// The founder's saved office. A layout main refuses here is exactly one
// `check:office` would fail: both judge with shared/office-grid.

/** The saved layout as it sits on disk; the renderer parses it, and falls back to the bundled one. */
export const loadOfficeDesign = (): JsonValue | null =>
  readJsonFile(OFFICE_DESIGN_PATH, jsonValueSchema);

/** Validate reachability as well as shape before replacing the saved office. */
export const saveOfficeDesign = (json: string): void => {
  const layout = parseOfficeLayout(parseJson(json));
  const issues = layoutIssues(layout);
  if (issues.length > 0) {
    throw new Error(`office layout rejected:\n${issues.join("\n")}`);
  }
  const body = `${JSON.stringify(canonicalOfficeLayout(layout), null, 2)}\n`;
  atomicWrite(OFFICE_DESIGN_PATH, body);
  // dev: mirror into the repo source so edited maps ship as the bundled
  // default (main runs from .output/app/main — three levels up = app root)
  if (!app.isPackaged) {
    const repoDesign = path.resolve(
      import.meta.dirname,
      "../../../src/renderer/game/office-design.json",
    );
    if (existsSync(path.dirname(repoDesign))) {
      atomicWrite(repoDesign, body);
    }
  }
};
