const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const repoRoot = path.resolve(__dirname, "../../..");
const defaultSource =
  "/Users/kyh/Desktop/vg/office/Modern_Office_Revamped_v1.2/4_Modern_Office_singles";
const sourceDir = process.env.OFFICE_OBJECT_SOURCE ?? defaultSource;
const publicDir = path.join(repoRoot, "apps/desktop/public/workspace-kit/office-objects");

// the game renders at 2x only; the 16/48 folders never ship
const SCALE = 32;
const sourceScaleDir = path.join(sourceDir, `${SCALE}x${SCALE}`);
const sourcePrefix = `Modern_Office_Singles_${SCALE}x${SCALE}_`;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const fileId = (file) => {
  const id = /_(?<id>\d+)\.png$/u.exec(file)?.groups?.id;
  return id === undefined ? null : Number(id);
};

const main = async () => {
  if (!fs.existsSync(sourceScaleDir)) {
    fail(
      `Missing source: ${sourceScaleDir}\nSet OFFICE_OBJECT_SOURCE=/path/to/4_Modern_Office_singles`,
    );
  }

  const targetDir = path.join(publicDir, `${SCALE}`);
  fs.rmSync(publicDir, { force: true, recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const ids = fs
    .readdirSync(sourceScaleDir)
    .filter((file) => file.endsWith(".png"))
    .map(fileId)
    .filter((id) => id !== null)
    .toSorted((a, b) => a - b);

  // office-object-sprite.ts reads each object's id off this file name
  for (const sourceId of ids) {
    const padded = String(sourceId).padStart(3, "0");
    await sharp(path.join(sourceScaleDir, `${sourcePrefix}${sourceId}.png`))
      .png()
      .toFile(path.join(targetDir, `modern-office-${SCALE}-${padded}.png`));
  }
  console.log(`imported ${ids.length} office objects`);
};

void main();
