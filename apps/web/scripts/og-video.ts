// Records the landing page's og:video: a small scene of the real office, drawn from the
// desktop app's own files (office-design.json, the employee sheets, px-kit and its VG5000),
// with a few employees typing, walking the floor and talking, beside a revenue ticker.
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
import { chromium } from "playwright";
import { z } from "zod";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");
const OUT_DIR = path.join(WEB_ROOT, "public/og");

const VIDEO = { fps: 24, height: 630, seconds: 8, width: 1200 } as const;
/** The office drawn at a whole multiple, so every sprite pixel stays square. */
const SCALE = 3;
/** The left of the frame is the office; the right is the panel beside it. */
const VIEW = { height: 210, width: 280, x: 72, y: 38 } as const;

// What the office scene uses: walk speed and walk-strip rate (npc.ts, characters.ts),
// the seated bust (character-sheet.ts) and its lift (seat-depth.ts), depth bands (office-depth.ts).
const NPC_SPEED = 64;
const WALK_FPS = 9;
const BEHIND_CHAIR_RISE = 12;
const DEPTH = { emote: 3000, entityBase: 1000, ground: 0, overhead: 2000 } as const;
const STACK_STEP = 1e-3;
const BUBBLE_DY = -56;

const characterDepth = (y: number): number => DEPTH.entityBase + y + SOLE_OFFSET;

const placedSchema = {
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  path: z.string(),
  x: z.number(),
  y: z.number(),
};
const officeSchema = z.object({
  objects: z.array(
    z.discriminatedUnion("layer", [
      z.object({ layer: z.literal("floor"), ...placedSchema }),
      z.object({ anchorY: z.number(), layer: z.literal("object"), ...placedSchema }),
      z.object({ layer: z.literal("overhead"), ...placedSchema }),
    ]),
  ),
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

interface BubbleDraw {
  text: string;
  x: number;
  y: number;
}

interface FeedLine {
  name: string;
  portrait: string;
  text: string;
}

interface FrameSpec {
  bubbles: BubbleDraw[];
  feed: FeedLine[];
  revenue: string;
  sale: string | null;
  sprites: SpriteDraw[];
}

interface SceneSetup {
  frame: { columns: number; h: number; originX: number; originY: number; w: number };
  objects: Placed[];
  scale: number;
  seats: Seat[];
  sheets: string[];
  view: { height: number; width: number; x: number; y: number };
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
  const sale = document.querySelector("#sale");
  const feed = document.querySelector("#feed");
  if (
    !(canvas instanceof HTMLCanvasElement) ||
    !(revenue instanceof HTMLElement) ||
    !(sale instanceof HTMLElement) ||
    !(feed instanceof HTMLElement)
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

  const bubble = (draw: BubbleDraw): void => {
    // npc-attachments.ts `say`: cream rounded box, ink outline, a tail under it
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const textW = ctx.measureText(draw.text).width;
    const w = Math.max(34, Math.ceil(textW) + 12);
    const h = 9 + 10;
    const ox = Math.round(draw.x);
    const oy = Math.round(draw.y);
    ctx.fillStyle = "#f8f5ec";
    ctx.strokeStyle = "#1d2136";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(ox - w / 2, oy - h - 4, w, h, 5);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox - 4, oy - 5);
    ctx.lineTo(ox + 4, oy - 5);
    ctx.lineTo(ox, oy + 1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ox - 4, oy - 4);
    ctx.lineTo(ox, oy + 1);
    ctx.lineTo(ox + 4, oy - 4);
    ctx.stroke();
    ctx.fillStyle = "#2b2f46";
    ctx.fillText(draw.text, ox, oy - 8);
  };

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone, so its helpers live inside it
  const ink = (tag: string, className: string, text: string): HTMLElement => {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  };

  window.ogScene = {
    draw: (spec) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#12141c";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(
        setup.scale,
        0,
        0,
        setup.scale,
        -setup.view.x * setup.scale,
        -setup.view.y * setup.scale,
      );

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
      for (const draw of spec.bubbles) {
        bubble(draw);
      }

      revenue.textContent = spec.revenue;
      sale.textContent = spec.sale ?? "";
      sale.style.visibility = spec.sale ? "visible" : "hidden";
      feed.replaceChildren(
        ...spec.feed.map((line) => {
          const row = ink("li", "row", "");
          const bust = document.createElement("img");
          bust.className = "px-bust";
          bust.src = line.portrait;
          bust.alt = "";
          const text = ink("div", "said", "");
          text.append(ink("div", "name", line.name), ink("div", "line", line.text));
          row.append(bust, text);
          return row;
        }),
      );
    },
  };
  return seatDepths;
};

// ---- the timeline: who is where at time t ----

const sheetPath = (n: number): string =>
  `/apps/desktop/public/characters/employee-sheet-${String(n).padStart(2, "0")}.png`;
const portraitPath = (n: number): string =>
  `/apps/desktop/public/characters/employee-portrait-${String(n).padStart(2, "0")}.png`;

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
  | { kind: "stand"; at: Point; facing: Dir; seconds: number }
  | { kind: "away"; seconds: number };

interface Actor {
  /** Their seat, if they start and end in it; the rest only ever sit. */
  legs: Leg[];
  name: string;
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

const spriteAt = (
  actor: Actor,
  t: number,
  seats: Seat[],
  seatDepths: number[],
): SpriteDraw | null => {
  let start = 0;
  const sheet = sheetPath(actor.sheet);
  for (const leg of actor.legs) {
    const seconds = legSeconds(leg);
    if (t < start + seconds || leg === actor.legs.at(-1)) {
      switch (leg.kind) {
        case "away": {
          return null;
        }
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
          const { at, facing } = alongPath(leg.path, (t - start) * NPC_SPEED);
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
    }
    start += seconds;
  }
  return null;
};

// Work seats from office-design.json, in its order: [2] top-left desk, [3]/[4] the row
// facing up, [1] the desk facing down beside the corridor.
const SEAT_INDEX = { corridor: 1, front: 2, middle: 4, wanderer: 3 } as const;

const actors: Actor[] = [
  {
    legs: [{ kind: "seated", seat: SEAT_INDEX.front, seconds: VIDEO.seconds }],
    name: "Ada",
    sheet: 4,
  },
  {
    legs: [{ kind: "seated", seat: SEAT_INDEX.middle, seconds: VIDEO.seconds }],
    name: "Rui",
    sheet: 9,
  },
  {
    legs: [{ kind: "seated", seat: SEAT_INDEX.corridor, seconds: VIDEO.seconds }],
    name: "Noor",
    sheet: 12,
  },
  {
    legs: [
      { kind: "seated", seat: SEAT_INDEX.wanderer, seconds: 0.9 },
      {
        kind: "walk",
        path: [
          { x: 144, y: 180 },
          { x: 144, y: 200 },
          { x: 264, y: 200 },
        ],
      },
      { at: { x: 264, y: 200 }, facing: "right", kind: "stand", seconds: 2 },
      {
        kind: "walk",
        path: [
          { x: 264, y: 200 },
          { x: 144, y: 200 },
          { x: 144, y: 180 },
        ],
      },
      { kind: "seated", seat: SEAT_INDEX.wanderer, seconds: VIDEO.seconds },
    ],
    name: "Theo",
    sheet: 2,
  },
  {
    legs: [
      { kind: "away", seconds: 0.4 },
      {
        kind: "walk",
        path: [
          { x: 372, y: 166 },
          { x: 196, y: 166 },
        ],
      },
      { at: { x: 196, y: 166 }, facing: "down", kind: "stand", seconds: 1.4 },
      {
        kind: "walk",
        path: [
          { x: 196, y: 166 },
          { x: 372, y: 166 },
        ],
      },
      { kind: "away", seconds: VIDEO.seconds },
    ],
    name: "Mika",
    sheet: 7,
  },
];

interface Line {
  from: number;
  /** Who says it: an actor's index. */
  speaker: number;
  text: string;
  until: number;
}

const LINES: Line[] = [
  { from: 3.1, speaker: 3, text: "deploying…", until: 4.6 },
  { from: 5, speaker: 1, text: "first sale!", until: 6.4 },
  { from: 6.3, speaker: 2, text: "ship it", until: 7.7 },
];

const SALES = [
  { amount: 9, at: 1.4 },
  { amount: 29, at: 4.9 },
  { amount: 9, at: 6.2 },
];
const REVENUE_START = 1284;
const TICK_SECONDS = 0.6;

const usd = (amount: number): string =>
  `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

const revenueAt = (t: number): number =>
  SALES.reduce(
    (sum, sale) => sum + sale.amount * Math.min(1, Math.max(0, (t - sale.at) / TICK_SECONDS)),
    REVENUE_START,
  );

const frameAt = (t: number, seats: Seat[], seatDepths: number[]): FrameSpec => {
  const sprites: SpriteDraw[] = [];
  const positions = new Map<number, SpriteDraw>();
  for (const [index, actor] of actors.entries()) {
    const sprite = spriteAt(actor, t, seats, seatDepths);
    if (sprite) {
      sprites.push(sprite);
      positions.set(index, sprite);
    }
  }
  const bubbles: BubbleDraw[] = [];
  for (const line of LINES) {
    const sprite = positions.get(line.speaker);
    if (sprite && t >= line.from && t < line.until) {
      bubbles.push({ text: line.text, x: sprite.x, y: sprite.y + BUBBLE_DY - sprite.rise });
    }
  }
  const feed = LINES.filter((line) => t >= line.from).map((line): FeedLine => {
    const actor = actors[line.speaker];
    return {
      name: actor?.name ?? "",
      portrait: portraitPath(actor?.sheet ?? 1),
      text: line.text,
    };
  });
  const recent = SALES.findLast((s) => t >= s.at && t < s.at + 1.2);
  return {
    bubbles,
    feed: feed.length > 0 ? feed : [{ name: "Ada", portrait: portraitPath(4), text: "on it" }],
    revenue: usd(revenueAt(t)),
    sale: recent ? `+${usd(recent.amount)} sale` : null,
    sprites,
  };
};

// ---- the page and the capture ----

const scenePage = (): string => `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/packages/px-kit/px-kit.css">
<style>
  html, body { margin: 0; width: ${VIDEO.width}px; height: ${VIDEO.height}px; overflow: hidden; background: var(--void); font-family: "VG5000", monospace; }
  .stage { display: flex; width: 100%; height: 100%; }
  #office { display: block; width: ${VIEW.width * SCALE}px; height: ${VIEW.height * SCALE}px; image-rendering: pixelated; border-right: 3px solid var(--ink); }
  .panel { flex: 1; display: flex; flex-direction: column; gap: 14px; padding: 18px 18px 18px 16px; box-sizing: border-box; }
  .wordmark { width: 230px; align-self: center; margin: -14px 0 -18px; }
  .tag { padding: 10px 12px; font-size: 13px; line-height: 1.5; color: var(--fg); }
  .tag b { color: var(--accent-lo); font-weight: 400; }
  .money { padding: 0; }
  .money .bar { display: flex; justify-content: space-between; padding: 5px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; }
  .money .body { display: flex; align-items: baseline; justify-content: space-between; padding: 8px 12px 10px; }
  #revenue { font-size: 30px; color: var(--fg); }
  #sale { font-size: 13px; color: var(--ok); }
  #feed { list-style: none; margin: 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
  #feed .row { display: flex; align-items: center; gap: 10px; }
  #feed .name { font-size: 11px; color: var(--accent-lo); }
  #feed .line { font-size: 13px; color: var(--fg); }
  .team { flex: 1; overflow: hidden; }
</style></head>
<body><div class="stage">
  <canvas id="office"></canvas>
  <div class="panel">
    <img class="wordmark" src="/apps/desktop/public/onboarding/idlebiz-wordmark.webp" alt="">
    <div class="px-battle tag">An idle business sim where your employees are <b>real AI agents</b>.</div>
    <div class="px-window money">
      <div class="px-titlebar bar"><span>Revenue</span><span>live</span></div>
      <div class="body"><span id="revenue"></span><span id="sale"></span></div>
    </div>
    <div class="px-window team">
      <div class="px-titlebar money"><div class="bar"><span>#team</span><span></span></div></div>
      <ul id="feed"></ul>
    </div>
  </div>
</div></body></html>`;

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
): Promise<{ body: Buffer | string; type: string } | null> => {
  if (pathname === "/") {
    return { body: scenePage(), type: "text/html" };
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

const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const reply = await respond(
    decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname),
  );
  if (reply) {
    response.writeHead(200, { "Content-Type": reply.type }).end(reply.body);
  } else {
    response.writeHead(404).end();
  }
};

/** The scene page and the repo files it draws, on a loopback port of its own. */
const serve = async (): Promise<{ server: Server; url: string }> => {
  // respond() answers every failure as a 404, so the request's promise never rejects
  const server = createServer((request, response) => {
    void answer(request, response);
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
  const seats: Seat[] = [
    { facing: "down", x: 112, y: 212 },
    { facing: "down", x: 304, y: 212 },
    { facing: "down", x: 144, y: 84 },
    { facing: "up", x: 144, y: 180 },
    { facing: "up", x: 240, y: 180 },
  ];
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
    view: VIEW,
  };

  const { server, url } = await serve();
  const frames = await mkdtemp(path.join(tmpdir(), "idlebiz-og-"));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({ viewport: { height: VIDEO.height, width: VIDEO.width } });
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
    ffmpeg([
      "-framerate",
      String(VIDEO.fps),
      "-i",
      path.join(frames, "frame-%04d.png"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-crf",
      "26",
      "-tune",
      "animation",
      "-movflags",
      "+faststart",
      "-an",
      video,
    ]);
    ffmpeg(["-i", path.join(frames, "frame-0060.png"), "-q:v", "3", path.join(OUT_DIR, "og.jpg")]);
    const { size } = await stat(video);
    process.stdout.write(`wrote ${video} (${(size / 1024).toFixed(0)} KiB)\n`);
  } finally {
    await browser.close();
    server.close();
    await rm(frames, { force: true, recursive: true });
  }
};

await main();
