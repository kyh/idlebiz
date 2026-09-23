import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { z } from "zod";
import { atomicWrite } from "@/main/lib/fs";
import { OFFICE_DESIGN_PATH } from "@/main/paths";
import { SOURCE_STANDING_FRAME } from "@/shared/character-frame";
import { errorMessage } from "@/shared/errors";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import { layoutIssues } from "@/shared/office-grid";
import {
  OFFICE_LAYOUT_VERSION,
  canonicalOfficeLayout,
  parseOfficeLayout,
} from "@/shared/office-layout-schema";
import type { OfficeDesign, OfficeLayoutData } from "@/shared/office-layout-schema";
import { unresolvedArt } from "@/shared/office-object-sprite";
import { opaqueMask, paintedSprites, sightIssues, standingSilhouette } from "@/shared/office-sight";
import type { OpaqueMask } from "@/shared/office-sight";

// The founder's saved office. A layout main refuses here is exactly one
// `check:office` would fail: both judge with shared/office-grid,
// shared/office-sight and shared/office-object-sprite, from the same PNGs.

/** Where the pixels the scene paints live on disk. */
export interface OfficeArt {
  /** The renderer's public/, as the page is served from it. */
  readonly publicDir: string;
  /** A source employee sheet whose standing pose stands in for every character's, as in check:office. */
  readonly sheet: string;
}

const newerStamp = z.object({ version: z.number().gt(OFFICE_LAYOUT_VERSION) });

/** A layout whose every object draws art this build ships; the scene and builder throw on any other. */
const withShippedArt = (layout: OfficeLayoutData): OfficeLayoutData => {
  const missing = unresolvedArt(layout);
  if (missing.length > 0) {
    throw new Error(`missing art: ${missing.join(", ")}`);
  }
  return layout;
};

/** The saved office, parsed; a file this build cannot read says so rather than passing for absent. */
export const loadOfficeDesign = (): OfficeDesign => {
  if (!existsSync(OFFICE_DESIGN_PATH)) {
    return { kind: "absent" };
  }
  let raw: JsonValue;
  try {
    raw = parseJson(readFileSync(OFFICE_DESIGN_PATH, "utf-8"));
  } catch (error) {
    return { kind: "unreadable", reason: errorMessage(error) };
  }
  if (newerStamp.safeParse(raw).success) {
    return { kind: "newer" };
  }
  try {
    return { kind: "saved", layout: withShippedArt(parseOfficeLayout(raw)) };
  } catch (error) {
    return { kind: "unreadable", reason: errorMessage(error) };
  }
};

/** Places the layout sends people that the scene's boot-time sight seal would cut off. */
const sightIssuesOf = async (layout: OfficeLayoutData, art: OfficeArt): Promise<string[]> => {
  // native, so loaded on a save rather than at boot
  const { default: sharp } = await import("sharp");
  const decode = async (file: string): Promise<OpaqueMask> => {
    // sharp cannot read inside the asar a packaged renderer ships public/ in; Electron's fs can
    const { data, info } = await sharp(await readFile(file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return opaqueMask({ data, h: info.height, w: info.width });
  };
  const [sprites, sheet] = await Promise.all([
    paintedSprites(layout, (spritePath) => decode(path.join(art.publicDir, spritePath))),
    decode(art.sheet),
  ]);
  return sightIssues(layout, sprites, standingSilhouette(sheet, SOURCE_STANDING_FRAME));
};

/** Validate art, reachability and sight before replacing the saved office; a newer build's file is never replaced. */
export const saveOfficeDesign = async (layout: OfficeLayoutData, art: OfficeArt): Promise<void> => {
  if (loadOfficeDesign().kind === "newer") {
    throw new Error("This office was saved by a newer IdleBiz; update to edit it.");
  }
  withShippedArt(layout);
  const walkable = layoutIssues(layout);
  // sight is judged on a grid that is already sound
  const issues = walkable.length > 0 ? walkable : await sightIssuesOf(layout, art);
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
