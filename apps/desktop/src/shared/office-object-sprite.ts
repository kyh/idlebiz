import type { OfficeLayoutData, OfficeObjectDef } from "./office-layout-schema.ts";
import { SPRITE_BOUNDS } from "./sprite-bounds.generated.ts";
import type { SpriteBounds } from "./sprite-bounds.generated.ts";

/** A sprite from the office kit: its id, its number in the source pack, and its PNG. */
interface OfficeObjectAsset {
  readonly id: string;
  readonly sourceId: number;
  readonly path: string;
}

const OFFICE_KIT_SPRITE = /^workspace-kit\/office-objects\/32\/modern-office-32-(?<n>\d+)\.png$/u;

/**
 * The office kit, read off the measured art: kit PNG NNN is placed as
 * `office-object-NNN`, so the one scan of the shipped art is also the catalog.
 */
export const OFFICE_OBJECT_ASSETS: readonly OfficeObjectAsset[] = [...SPRITE_BOUNDS.keys()]
  .flatMap((path) => {
    const n = OFFICE_KIT_SPRITE.exec(path)?.groups?.n;
    return n === undefined ? [] : [{ id: `office-object-${n}`, path, sourceId: Number(n) }];
  })
  .toSorted((a, b) => a.sourceId - b.sourceId);

const PATH_OF = new Map(OFFICE_OBJECT_ASSETS.map((asset) => [asset.id, asset.path]));

/**
 * The PNG a placed object draws, relative to public/: its own path when it
 * names one (room-builder tiles), else the kit sprite for its id. The
 * scene, the builder, the save handler and check:office all resolve through
 * here, so none can read a different pixel than the game paints. Relative
 * imports with extensions so Node can load it for the gate.
 */
export const objectSpritePath = (obj: Pick<OfficeObjectDef, "id" | "path">): string => {
  const found = obj.path ?? PATH_OF.get(obj.id);
  if (found === undefined) {
    throw new Error(`Missing office object asset: ${obj.id}`);
  }
  return found;
};

/** The measured size of a PNG from `objectSpritePath`; `generate:sprite-bounds` writes the table. */
export const spriteBounds = (spritePath: string): SpriteBounds => {
  const found = SPRITE_BOUNDS.get(spritePath);
  if (found === undefined) {
    throw new Error(`Unmeasured sprite: ${spritePath} (run generate:sprite-bounds)`);
  }
  return found;
};

const resolves = (obj: Pick<OfficeObjectDef, "id" | "path">): boolean => {
  const found = obj.path ?? PATH_OF.get(obj.id);
  return found !== undefined && SPRITE_BOUNDS.has(found);
};

/**
 * Ids of placed objects whose art this build lacks: no sprite, or one never
 * measured. The two lookups above throw on these, so a layout naming any is
 * refused where it is loaded, never handed to the scene or the builder.
 */
export const unresolvedArt = (layout: Pick<OfficeLayoutData, "objects">): string[] => [
  ...new Set(layout.objects.filter((obj) => !resolves(obj)).map((obj) => obj.id)),
];
