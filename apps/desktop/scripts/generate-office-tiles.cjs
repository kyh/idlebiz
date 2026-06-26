const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const repoRoot = path.resolve(__dirname, "../../..");
const defaultSource =
  "/Users/kyh/Desktop/vg/office/Modern_Office_Revamped_v1.2/1_Room_Builder_Office/Room_Builder_Office_32x32.png";
const sourcePath = process.env.OFFICE_TILE_SOURCE || defaultSource;
const targetDir = path.join(repoRoot, "apps/desktop/public/workspace-kit/office-tiles");

const tileSize = 32;
// Cells chosen to match 6_Office_Designs/Office_Design_2: main room uses the
// light square gray tile; the two lower rooms use the gray vertical-plank tile;
// the lower rooms' top band is tan brick; the top room wall is the wallpaper.
const tiles = [
  { name: "floor-gray", col: 11, row: 6 }, // main room: smooth light gray (exact match)
  { name: "floor-plank", col: 14, row: 6 }, // lower rooms: light gray plank (exact match)
  { name: "floor-wood", col: 13, row: 5 }, // retained variant
  { name: "wall-paper", col: 5, row: 11 },
  { name: "wall-brick", col: 4, row: 9 },
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  if (!fs.existsSync(sourcePath)) {
    fail(
      `Missing source: ${sourcePath}\nSet OFFICE_TILE_SOURCE=/path/to/Room_Builder_Office_32x32.png`,
    );
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  for (const tile of tiles) {
    await sharp(sourcePath)
      .extract({
        left: tile.col * tileSize,
        top: tile.row * tileSize,
        width: tileSize,
        height: tileSize,
      })
      .png()
      .toFile(path.join(targetDir, `${tile.name}.png`));
  }

  console.log(`generated ${tiles.length} office tiles`);
}

void main();
