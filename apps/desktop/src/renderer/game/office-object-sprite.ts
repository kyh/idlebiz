import type { OfficeObjectDef } from "../../shared/office-layout-schema.ts";
import { OFFICE_OBJECT_ASSETS } from "./office-object-catalog.generated.ts";

const PATH_OF = new Map(OFFICE_OBJECT_ASSETS.map((asset) => [asset.id, asset.path]));

/**
 * The PNG a placed object draws, relative to public/: its own path when it
 * names one (room-builder tiles), else the catalog sprite for its id. The
 * scene and check:office both resolve through here, so the gate can never
 * read a different pixel than the game paints. Relative imports with
 * extensions, like shared/, so Node can load it for the gate.
 */
export function objectSpritePath(obj: Pick<OfficeObjectDef, "id" | "path">): string {
  const found = obj.path ?? PATH_OF.get(obj.id);
  if (found === undefined) throw new Error(`Missing office object asset: ${obj.id}`);
  return found;
}
