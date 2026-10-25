// Records the landing page's og:video: the whole office, drawn from the desktop app's own files
// (office-design.json, the employee sheets, px-kit and its VG5000, the wordmark), with the team
// typing at their desks, walking to the cooler and across the floor, beside the IdleBiz logo and its line, while the HUD's revenue plate counts up in the corner.
//
// The real office needs a signed-in CLI, so this draws the same art the same way the scene
// does (placed sprites, floor-contact sorting, seated busts) on a canvas, one frame at a time
// on a fixed clock, screenshots each and hands them to ffmpeg. Not part of any build:
//
//   pnpm -F @repo/web og:video
//
// Writes public/og/og.mp4 and its poster public/og/og.jpg. Needs Playwright's Chromium
// (PLAYWRIGHT_CHROMIUM names another build) and ffmpeg on PATH.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CHAR_ORIGIN_X,
  CHAR_ORIGIN_Y,
  FRAME_H,
  FRAME_W,
  SHEET_COLUMNS,
  SOLE_OFFSET,
  STRIP_FRAMES,
  WALK_START,
} from "@repo/domain/character-frame";
import type { Dir } from "@repo/domain/character-frame";
import { usageLabel } from "@repo/domain/format";
import { chromium } from "playwright";
import { z } from "zod";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");
const OUT_DIR = path.join(WEB_ROOT, "public/og");

/** 8s holds whole cycles of the 6-frame walk strip at 9fps, so the loop has no seam. */
const VIDEO = { fps: 24, height: 630, seconds: 8, width: 1200 } as const;
/** Captured at twice the clip's size, then scaled down, so the office's pixels stay even. */
const CAPTURE_SCALE = 2;
/** The canvas draws the office at a whole multiple, so every sprite pixel starts square. */
const SCALE = 4;
/** Where the whole office sits in the frame, in CSS px. */
const STAGE = { height: 612, right: 20 } as const;

// What the office scene uses: walk speed and walk-strip rate (npc.ts, characters.ts), the
// seated bust's lift (seat-depth.ts) and depth bands (office-depth.ts).
const NPC_SPEED = 64;
const WALK_FPS = 9;
const BEHIND_CHAIR_RISE = 12;
const DEPTH = { entityBase: 1000, ground: 0, overhead: 2000 } as const;
const STACK_STEP = 1e-3;

const characterDepth = (y: number): number => DEPTH.entityBase + y + SOLE_OFFSET;

const placedSchema = {
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  path: z.string(),
  x: z.number(),
  y: z.number(),
};
const dirSchema = z.enum(["down", "left", "right", "up"]);
const officeSchema = z.object({
  height: z.number(),
  objects: z.array(
    z.discriminatedUnion("layer", [
      z.object({ layer: z.literal("floor"), ...placedSchema }),
      z.object({ anchorY: z.number(), layer: z.literal("object"), ...placedSchema }),
      z.object({ layer: z.literal("overhead"), ...placedSchema }),
    ]),
  ),
  seats: z.array(
    z.discriminatedUnion("role", [
      z.object({ facing: dirSchema, role: z.literal("work"), x: z.number(), y: z.number() }),
      z.object({
        role: z.literal("rest"),
        sit: z.enum(["left", "right"]),
        x: z.number(),
        y: z.number(),
      }),
    ]),
  ),
  width: z.number(),
});

interface Point {
  x: number;
  y: number;
}

interface Placed {
  depth: number;
  flipX: boolean;
  flipY: boolean;
  src: string;
  x: number;
  y: number;
}

interface Seat extends Point {
  facing: Dir;
}

/** One character as a frame draws it. */
interface SpriteDraw {
  crop: boolean;
  depth: number;
  frame: number;
  rise: number;
  sheet: string;
  x: number;
  y: number;
}

interface FrameSpec {
  /** The revenue plate: its figure, its usage line, and a sale floating off it. */
  revenue: string;
  sale: { lift: number; opacity: number; text: string } | null;
  sprites: SpriteDraw[];
  usage: string;
}

interface SceneSetup {
  frame: { columns: number; h: number; originX: number; originY: number; w: number };
  objects: Placed[];
  scale: number;
  seats: Seat[];
  sheets: string[];
  view: { height: number; width: number };
}

declare global {
  interface Window {
    ogScene?: { draw: (frame: FrameSpec) => void };
  }
}

const paintOrder = (layout: z.infer<typeof officeSchema>): Placed[] =>
  layout.objects.map((obj, index) => {
    let depth = DEPTH.ground + STACK_STEP * (index + 1);
    if (obj.layer === "object") {
      depth = DEPTH.entityBase + obj.anchorY + 0.5;
    } else if (obj.layer === "overhead") {
      depth = DEPTH.overhead + STACK_STEP * (index + 1);
    }
    return {
      depth,
      flipX: obj.flipX ?? false,
      flipY: obj.flipY ?? false,
      src: `/apps/desktop/public/${obj.path}`,
      x: obj.x,
      y: obj.y,
    };
  });

// ---- the browser half: runs in the page, so it closes over nothing ----

/**
 * Loads the art, works out where each seated bust sorts (seat-depth.ts: just above the
 * topmost furniture it overlaps, read from each image's opaque pixels; facing up, behind the
 * chair back) and installs `window.ogScene.draw`.
 */
const mountScene = async (setup: SceneSetup): Promise<number[]> => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone, so its helpers live inside it
  const load = async (src: string): Promise<HTMLImageElement> => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  };
  const sources = [...new Set([...setup.objects.map((obj) => obj.src), ...setup.sheets])];
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(sources.map(async (src) => images.set(src, await load(src))));
  await Promise.all([...document.images].map(async (img) => await img.decode()));
  await document.fonts.ready;

  const opaque = new Map<string, Uint8ClampedArray>();
  const alphaOf = (img: HTMLImageElement, src: string): Uint8ClampedArray => {
    const known = opaque.get(src);
    if (known) {
      return known;
    }
    const scratch = document.createElement("canvas");
    scratch.width = img.naturalWidth;
    scratch.height = img.naturalHeight;
    const sctx = scratch.getContext("2d");
    const data = sctx
      ? (sctx.drawImage(img, 0, 0),
        sctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data)
      : new Uint8ClampedArray(0);
    opaque.set(src, data);
    return data;
  };

  const seatDepths = setup.seats.map((seat) => {
    const base = 1000 + seat.y + (62 - setup.frame.h * setup.frame.originY);
    if (seat.facing === "up") {
      return base;
    }
    let depth = base;
    for (const obj of setup.objects) {
      const img = images.get(obj.src);
      if (!img || obj.depth <= depth || obj.depth >= 2000) {
        continue;
      }
      const x0 = Math.floor(Math.max(seat.x - 10, obj.x));
      const x1 = Math.ceil(Math.min(seat.x + 10, obj.x + img.naturalWidth));
      const bustTop = seat.y - (Math.ceil(setup.frame.h * setup.frame.originY) - 18);
      const y0 = Math.floor(Math.max(bustTop, obj.y));
      const y1 = Math.ceil(Math.min(seat.y, obj.y + img.naturalHeight));
      if (x1 <= x0 || y1 <= y0) {
        continue;
      }
      const alpha = alphaOf(img, obj.src);
      let hit = false;
      for (let y = y0; y < y1 && !hit; y += 1) {
        for (let x = x0; x < x1 && !hit; x += 1) {
          let lx = Math.floor(x - obj.x);
          let ly = Math.floor(y - obj.y);
          lx = obj.flipX ? img.naturalWidth - 1 - lx : lx;
          ly = obj.flipY ? img.naturalHeight - 1 - ly : ly;
          hit = (alpha[(ly * img.naturalWidth + lx) * 4 + 3] ?? 0) > 0;
        }
      }
      if (hit) {
        depth = Math.max(depth, obj.depth);
      }
    }
    return depth + 0.25;
  });

  const canvas = document.querySelector("#office");
  const revenue = document.querySelector("#revenue");
  const usage = document.querySelector("#usage");
  const sale = document.querySelector("#sale");
  if (
    !(canvas instanceof HTMLCanvasElement) ||
    !(revenue instanceof HTMLElement) ||
    !(usage instanceof HTMLElement) ||
    !(sale instanceof HTMLElement)
  ) {
    throw new Error("the scene page is missing an element");
  }
  canvas.width = setup.view.width * setup.scale;
  canvas.height = setup.view.height * setup.scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("no 2d context");
  }

  const blit = (img: HTMLImageElement, obj: Placed): void => {
    ctx.save();
    ctx.translate(
      obj.x + (obj.flipX ? img.naturalWidth : 0),
      obj.y + (obj.flipY ? img.naturalHeight : 0),
    );
    ctx.scale(obj.flipX ? -1 : 1, obj.flipY ? -1 : 1);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  };

  window.ogScene = {
    draw: (spec) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(setup.scale, 0, 0, setup.scale, 0, 0);

      interface Item {
        depth: number;
        paint: () => void;
      }
      const items: Item[] = setup.objects.flatMap((obj) => {
        const img = images.get(obj.src);
        return img ? [{ depth: obj.depth, paint: () => blit(img, obj) }] : [];
      });
      for (const sprite of spec.sprites) {
        const img = images.get(sprite.sheet);
        if (!img) {
          continue;
        }
        const { columns, h, originX, originY, w } = setup.frame;
        const sx = (sprite.frame % columns) * w;
        const sy = Math.floor(sprite.frame / columns) * h;
        const drawH = sprite.crop ? Math.round(h * originY) : h;
        const left = Math.round(sprite.x - w * originX);
        const top = Math.round(sprite.y - h * (originY + sprite.rise / h));
        items.push({
          depth: sprite.depth,
          paint: () => ctx.drawImage(img, sx, sy, w, drawH, left, top, w, drawH),
        });
      }
      items.sort((a, b) => a.depth - b.depth);
      for (const item of items) {
        item.paint();
      }

      revenue.textContent = spec.revenue;
      usage.textContent = spec.usage;
      sale.textContent = spec.sale?.text ?? "";
      sale.style.opacity = String(spec.sale?.opacity ?? 0);
      sale.style.transform = `translateY(${String(-(spec.sale?.lift ?? 0))}px)`;
    },
  };
  return seatDepths;
};

// ---- the timeline: who is where at time t ----

const sheetPath = (n: number): string =>
  `/apps/desktop/public/characters/employee-sheet-${String(n).padStart(2, "0")}.png`;

const walkFrame = (dir: Dir, t: number): number =>
  WALK_START[dir] + (Math.floor(t * WALK_FPS) % STRIP_FRAMES);

const facingOf = (from: Point, to: Point): Dir => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx < 0 ? "left" : "right";
  }
  return dy < 0 ? "up" : "down";
};

type Leg =
  | { kind: "seated"; seat: number; seconds: number }
  | { kind: "walk"; path: Point[] }
  | { kind: "stand"; at: Point; facing: Dir; seconds: number };

interface Actor {
  legs: Leg[];
  sheet: number;
}

const legSeconds = (leg: Leg): number => {
  if (leg.kind !== "walk") {
    return leg.seconds;
  }
  let length = 0;
  for (let i = 1; i < leg.path.length; i += 1) {
    const a = leg.path[i - 1];
    const b = leg.path[i];
    if (a && b) {
      length += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return length / NPC_SPEED;
};

interface Step {
  at: Point;
  facing: Dir;
}

const alongPath = (pathPoints: Point[], distance: number): Step => {
  let left = distance;
  for (let i = 1; i < pathPoints.length; i += 1) {
    const a = pathPoints[i - 1];
    const b = pathPoints[i];
    if (!a || !b) {
      continue;
    }
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= length || i === pathPoints.length - 1) {
      const f = length === 0 ? 1 : Math.min(1, left / length);
      return { at: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, facing: facingOf(a, b) };
    }
    left -= length;
  }
  return { at: pathPoints[0] ?? { x: 0, y: 0 }, facing: "down" };
};

const legSprite = (
  leg: Leg,
  since: number,
  t: number,
  sheet: string,
  seats: Seat[],
  seatDepths: number[],
): SpriteDraw | null => {
  switch (leg.kind) {
    case "seated": {
      const seat = seats[leg.seat];
      if (!seat) {
        return null;
      }
      // the sheet has no typing strip: walking in place, facing the screen, reads as typing
      return {
        crop: true,
        depth: seatDepths[leg.seat] ?? characterDepth(seat.y),
        frame: walkFrame(seat.facing, t),
        rise: seat.facing === "up" ? BEHIND_CHAIR_RISE : 0,
        sheet,
        x: seat.x,
        y: seat.y,
      };
    }
    case "stand": {
      return {
        crop: false,
        depth: characterDepth(leg.at.y),
        frame: WALK_START[leg.facing],
        rise: 0,
        sheet,
        x: leg.at.x,
        y: leg.at.y,
      };
    }
    case "walk": {
      const { at, facing } = alongPath(leg.path, (t - since) * NPC_SPEED);
      return {
        crop: false,
        depth: characterDepth(at.y),
        frame: walkFrame(facing, t),
        rise: 0,
        sheet,
        x: at.x,
        y: at.y,
      };
    }
    // no default
  }
};

const spriteAt = (
  actor: Actor,
  t: number,
  seats: Seat[],
  seatDepths: number[],
): SpriteDraw | null => {
  let start = 0;
  for (const leg of actor.legs) {
    const seconds = legSeconds(leg);
    if (t < start + seconds || leg === actor.legs.at(-1)) {
      return legSprite(leg, start, t, sheetPath(actor.sheet), seats, seatDepths);
    }
    start += seconds;
  }
  return null;
};

/** A walk there and the same walk back. */
const outAndBack = (points: Point[]): [Leg, Leg] => [
  { kind: "walk", path: points },
  { kind: "walk", path: points.toReversed() },
];

// Work seats are office-design.json's, by index: [0]-[2] face down, [3]-[9] face up across the
// two rows of desks, [10] faces left in the back room. [5] is the one who gets up for the cooler.
const SEATED = [
  { seat: 0, sheet: 4 },
  { seat: 1, sheet: 9 },
  { seat: 2, sheet: 12 },
  { seat: 3, sheet: 6 },
  { seat: 4, sheet: 15 },
  { seat: 7, sheet: 11 },
  { seat: 9, sheet: 17 },
  { seat: 10, sheet: 3 },
] as const;
const COOLER_SEAT = 5;

const actors: Actor[] = [
  ...SEATED.map(({ seat, sheet }): Actor => ({
    legs: [{ kind: "seated", seat, seconds: VIDEO.seconds }],
    sheet,
  })),
  {
    // up from the desk, along the corridor to the cooler, a drink, and back
    legs: [
      { kind: "seated", seat: COOLER_SEAT, seconds: 0.6 },
      ...outAndBack([
        { x: 336, y: 180 },
        { x: 336, y: 200 },
        { x: 440, y: 200 },
        { x: 440, y: 172 },
      ]).toSpliced(1, 0, { at: { x: 440, y: 172 }, facing: "up", kind: "stand", seconds: 1.8 }),
      { kind: "seated", seat: COOLER_SEAT, seconds: VIDEO.seconds },
    ],
    sheet: 2,
  },
  {
    // from the back room's printer up the passage to the desks, a look, and back
    legs: [
      { at: { x: 304, y: 408 }, facing: "up", kind: "stand", seconds: 0.4 },
      ...outAndBack([
        { x: 304, y: 408 },
        { x: 336, y: 408 },
        { x: 336, y: 296 },
        { x: 272, y: 296 },
      ]).toSpliced(1, 0, { at: { x: 272, y: 296 }, facing: "up", kind: "stand", seconds: 1 }),
      { at: { x: 304, y: 408 }, facing: "up", kind: "stand", seconds: VIDEO.seconds },
    ],
    sheet: 7,
  },
  {
    // across the front corridor to chat at a desk, and back
    legs: [
      { at: { x: 96, y: 200 }, facing: "right", kind: "stand", seconds: 0.8 },
      ...outAndBack([
        { x: 96, y: 200 },
        { x: 200, y: 200 },
      ]).toSpliced(1, 0, { at: { x: 200, y: 200 }, facing: "up", kind: "stand", seconds: 2.2 }),
      { at: { x: 96, y: 200 }, facing: "right", kind: "stand", seconds: VIDEO.seconds },
    ],
    sheet: 14,
  },
];

// ---- the HUD's revenue plate ----

const SALES = [
  { amount: 29, at: 0.9 },
  { amount: 9, at: 2.4 },
  { amount: 49, at: 3.8 },
  { amount: 9, at: 5.2 },
  { amount: 29, at: 6.4 },
] as const;
const REVENUE_START = 1284;
const USAGE = { from: 41.2, to: 43.6 } as const;
/** How long a sale takes to count onto the plate, and the loop's roll back to its start. */
const TICK_SECONDS = 0.5;
const ROLLBACK = { from: 7.65, to: 7.95 } as const;
const SALE_FLOAT_SECONDS = 1.1;

const easeOut = (f: number): number => 1 - (1 - f) ** 3;
const clamp01 = (f: number): number => Math.min(1, Math.max(0, f));

/** How far the loop's roll back has gone: 0 until it starts, 1 once both figures are home. */
const rolledBack = (t: number): number =>
  clamp01((t - ROLLBACK.from) / (ROLLBACK.to - ROLLBACK.from));

const revenueAt = (t: number): number => {
  const counted = SALES.reduce(
    (sum, sale) => sum + sale.amount * easeOut(clamp01((t - sale.at) / TICK_SECONDS)),
    REVENUE_START,
  );
  return counted + (REVENUE_START - counted) * rolledBack(t);
};

const usageAt = (t: number): number =>
  USAGE.from + (USAGE.to - USAGE.from) * clamp01(t / ROLLBACK.from) * (1 - rolledBack(t));

const frameAt = (t: number, seats: Seat[], seatDepths: number[]): FrameSpec => {
  const sprites = actors.flatMap((actor) => spriteAt(actor, t, seats, seatDepths) ?? []);
  const recent = SALES.findLast((s) => t >= s.at && t < s.at + SALE_FLOAT_SECONDS);
  const sale = recent
    ? {
        lift: 22 * easeOut((t - recent.at) / SALE_FLOAT_SECONDS),
        opacity: Math.min(1, (recent.at + SALE_FLOAT_SECONDS - t) / 0.35),
        text: `+$${String(recent.amount)}`,
      }
    : null;
  return {
    revenue: `$${Math.round(revenueAt(t)).toLocaleString("en-US")}`,
    sale,
    sprites,
    usage: usageLabel(usageAt(t)),
  };
};

// ---- the page and the capture ----

/** The wordmark's art inside its canvas, in its own px: the page crops the margin away. */
const WORDMARK = { art: { h: 728, w: 1029, x: 257, y: 166 }, width: 1513 } as const;
const LOGO_WIDTH = 400;
/** The brand sits under the HUD's plate, which takes the top of the frame's left side. */
const BRAND_TOP = 168;

const scenePage = (view: SceneSetup["view"]): string => {
  const officeWidth = Math.round((STAGE.height * view.width) / view.height);
  const logoScale = LOGO_WIDTH / WORDMARK.art.w;
  const brandWidth = VIDEO.width - officeWidth - STAGE.right;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/packages/px-kit/px-kit.css">
<style>
  html, body { margin: 0; width: ${VIDEO.width}px; height: ${VIDEO.height}px; overflow: hidden; background: var(--void); font-family: "VG5000", monospace; }
  #office { position: absolute; right: ${STAGE.right}px; top: ${(VIDEO.height - STAGE.height) / 2}px; width: ${officeWidth}px; height: ${STAGE.height}px; }
  .brand { position: absolute; left: 0; top: ${BRAND_TOP}px; width: ${brandWidth}px; height: ${VIDEO.height - BRAND_TOP - 12}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; }
  .logo { width: ${LOGO_WIDTH}px; height: ${Math.round(WORDMARK.art.h * logoScale)}px; overflow: hidden; }
  .logo img { display: block; width: ${Math.round(WORDMARK.width * logoScale)}px; margin: ${-Math.round(WORDMARK.art.y * logoScale)}px 0 0 ${-Math.round(WORDMARK.art.x * logoScale)}px; }
  .line { width: 440px; text-align: center; font-size: 21px; line-height: 1.5; color: var(--light); }
  .line b { color: var(--accent-hi); font-weight: 400; }
  /* hud.tsx's revenue Stat (top-3 left-3), drawn at twice its size so it reads in a share card */
  .hud { position: absolute; top: 12px; left: 12px; zoom: 2; display: flex; align-items: center; gap: 6px; }
  .stat { display: flex; min-width: 64px; align-items: center; padding: 6px 12px; }
  .stat .label { display: block; color: #c3c9de; }
  .stat .value { display: block; font-size: 16px; line-height: 1.25; color: #9fe6b0; font-variant-numeric: tabular-nums; }
  .stat .sub { display: block; font-size: 12px; color: #a7adc6; font-variant-numeric: tabular-nums; }
  #sale { font-size: 14px; color: #9fe6b0; text-shadow: 1px 1px 0 var(--ink); }
</style></head>
<body>
  <canvas id="office"></canvas>
  <div class="brand">
    <div class="logo"><img src="/apps/desktop/public/onboarding/idlebiz-wordmark.webp" alt=""></div>
    <div class="line">An idle game business simulator where your employees are <b>real AI agents</b>.</div>
  </div>
  <div class="hud">
    <div class="px-plate stat"><span>
      <span class="px-label label">revenue ⚡</span>
      <span class="value" id="revenue"></span>
      <span class="sub" id="usage"></span>
    </span></div>
    <span id="sale"></span>
  </div>
</body></html>`;
};

const MIME = new Map([
  [".css", "text/css"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);
const SERVED = ["apps/desktop/public/", "packages/px-kit/"];
const addressSchema = z.object({ port: z.number() });

const respond = async (
  pathname: string,
  page: string,
): Promise<{ body: Buffer | string; type: string } | null> => {
  if (pathname === "/") {
    return { body: page, type: "text/html" };
  }
  const file = path.join(REPO_ROOT, pathname);
  const relative = path.relative(REPO_ROOT, file);
  const type = MIME.get(path.extname(file));
  if (!type || relative.includes("..") || !SERVED.some((dir) => relative.startsWith(dir))) {
    return null;
  }
  try {
    return { body: await readFile(file), type };
  } catch {
    return null;
  }
};

const answer = async (
  request: IncomingMessage,
  response: ServerResponse,
  page: string,
): Promise<void> => {
  const reply = await respond(
    decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname),
    page,
  );
  if (reply) {
    response.writeHead(200, { "Content-Type": reply.type }).end(reply.body);
  } else {
    response.writeHead(404).end();
  }
};

/** The scene page and the repo files it draws, on a loopback port of its own. */
const serve = async (page: string): Promise<{ server: Server; url: string }> => {
  // respond() answers every failure as a 404, so the request's promise never rejects
  const server = createServer((request, response) => {
    void answer(request, response, page);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = addressSchema.parse(server.address());
  return { server, url: `http://127.0.0.1:${port}/` };
};

const ffmpeg = (args: string[]): void => {
  const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (run.status !== 0) {
    throw new Error(`ffmpeg exited ${String(run.status)}`);
  }
};

const main = async (): Promise<void> => {
  const layout = officeSchema.parse(
    JSON.parse(
      await readFile(
        path.join(REPO_ROOT, "apps/desktop/src/renderer/game/office-design.json"),
        "utf-8",
      ),
    ),
  );
  const seats = layout.seats.map((seat): Seat => ({
    facing: seat.role === "work" ? seat.facing : "down",
    x: seat.x,
    y: seat.y,
  }));
  const view = { height: layout.height, width: layout.width };
  const setup: SceneSetup = {
    frame: {
      columns: SHEET_COLUMNS,
      h: FRAME_H,
      originX: CHAR_ORIGIN_X,
      originY: CHAR_ORIGIN_Y,
      w: FRAME_W,
    },
    objects: paintOrder(layout),
    scale: SCALE,
    seats,
    sheets: actors.map((actor) => sheetPath(actor.sheet)),
    view,
  };

  const { server, url } = await serve(scenePage(view));
  const frames = await mkdtemp(path.join(tmpdir(), "idlebiz-og-"));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({
      deviceScaleFactor: CAPTURE_SCALE,
      viewport: { height: VIDEO.height, width: VIDEO.width },
    });
    await page.goto(url);
    const seatDepths = await page.evaluate(mountScene, setup);
    const total = VIDEO.fps * VIDEO.seconds;
    for (let index = 0; index < total; index += 1) {
      const spec = frameAt(index / VIDEO.fps, seats, seatDepths);
      await page.evaluate((frame) => window.ogScene?.draw(frame), spec);
      await page.screenshot({
        animations: "disabled",
        path: path.join(frames, `frame-${String(index).padStart(4, "0")}.png`),
      });
    }
    await mkdir(OUT_DIR, { recursive: true });
    const video = path.join(OUT_DIR, "og.mp4");
    const scale = `scale=${String(VIDEO.width)}:${String(VIDEO.height)}:flags=lanczos`;
    ffmpeg([
      "-framerate",
      String(VIDEO.fps),
      "-i",
      path.join(frames, "frame-%04d.png"),
      "-vf",
      scale,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-crf",
      "24",
      "-tune",
      "animation",
      "-movflags",
      "+faststart",
      "-an",
      video,
    ]);
    // the poster is the moment the third sale lands
    ffmpeg([
      "-i",
      path.join(frames, "frame-0096.png"),
      "-vf",
      scale,
      "-q:v",
      "3",
      path.join(OUT_DIR, "og.jpg"),
    ]);
    const { size } = await stat(video);
    process.stdout.write(`wrote ${video} (${(size / 1024).toFixed(0)} KiB)\n`);
  } finally {
    await browser.close();
    server.close();
    await rm(frames, { force: true, recursive: true });
  }
};

await main();
