import type { OfficeObjectDef } from "../../shared/office-layout-schema.ts";
import { OFFICE_OBJECT_ASSETS } from "./office-object-catalog.generated.ts";
import { SPRITE_BOUNDS } from "./sprite-bounds.generated.ts";
import type { SpriteBounds } from "./sprite-bounds.generated.ts";

const PATH_OF = new Map(OFFICE_OBJECT_ASSETS.map((asset) => [asset.id, asset.path]));

/**
 * The PNG a placed object draws, relative to public/: its own path when it
 * names one (room-builder tiles), else the catalog sprite for its id. The
 * scene, the builder and check:office all resolve through here, so none can
 * read a different pixel than the game paints. Relative imports with
 * extensions, like shared/, so Node can load it for the gate.
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
