import { describe, expect, it } from "vitest";
import { ALL_OBJECT_IDS, ROOM_TILES, assetSrc, srcForObject } from "./office-builder-model";

// The packaged app loads the renderer over file://, where a root-absolute src lands at
// the filesystem root instead of beside index.html.
const page = "file:///Applications/IdleBiz.app/Contents/Resources/app.asar/renderer/index.html#/ui";
const rendererDir = new URL("./", page).href;
const missesPage = (src: string | null): boolean =>
  src === null || !new URL(src, page).href.startsWith(rendererDir);

describe("builder sprite srcs", () => {
  it("resolve beside a file:// page for every catalog sprite", () => {
    expect(ALL_OBJECT_IDS.filter((id) => missesPage(assetSrc(id)))).toEqual([]);
    expect(ALL_OBJECT_IDS.filter((id) => missesPage(srcForObject({ id })))).toEqual([]);
  });

  it("resolve beside a file:// page for every room tile", () => {
    const placed = ROOM_TILES.map((t) => srcForObject({ id: t.id, path: t.path }));
    expect(placed.filter(missesPage)).toEqual([]);
  });

  it("has no src for an id the catalog does not know", () => {
    expect(assetSrc("no-such-object")).toBeNull();
    expect(srcForObject({ id: "no-such-object" })).toBeNull();
  });
});
