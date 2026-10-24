import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

import type { ProsePage } from "@/lib/agent/site-content";
import { siteConfig } from "@/lib/site-config";

/** The size every share card is drawn at, and the one `pageMetadata` declares. */
export const OG_SIZE = { height: 630, width: 1200 };

const INK = "#1d2136";

const pngDataUrl = async (file: string): Promise<string> => {
  const png = await readFile(path.join(process.cwd(), "public/office", file));
  return `data:image/png;base64,${png.toString("base64")}`;
};

const Sprite = ({ src, width, height }: { src: string; width: number; height: number }) => (
  <div
    style={{
      backgroundImage: `url(${src})`,
      backgroundSize: `${width}px ${height}px`,
      height,
      imageRendering: "pixelated",
      width,
    }}
  />
);

interface OgCard {
  /** The window's title bar. */
  bar: string;
  heading: string;
  line: string;
}

/** A share card: the site's window, a heading and a line beside the office's desk and cooler. */
export const ogCard = async ({ bar, heading, line }: OgCard): Promise<ImageResponse> => {
  const [desk, cooler] = await Promise.all([pngDataUrl("desk.png"), pngDataUrl("cooler.png")]);
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#12141c",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <div
        style={{
          background: "#ece7d8",
          border: `6px solid ${INK}`,
          display: "flex",
          flexDirection: "column",
          width: 1000,
        }}
      >
        <div
          style={{
            background: "#44507a",
            borderBottom: `6px solid ${INK}`,
            color: "#f5f3ea",
            display: "flex",
            fontSize: 26,
            justifyContent: "space-between",
            letterSpacing: 3,
            padding: "12px 24px",
          }}
        >
          <span>IDLEBIZ.EXE</span>
          <span>{bar.toUpperCase()}</span>
        </div>
        <div style={{ alignItems: "flex-end", display: "flex", gap: 48, padding: "40px 56px" }}>
          <Sprite src={desk} width={156} height={288} />
          <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 24 }}>
            <div
              style={{
                color: INK,
                fontSize: heading.length > 10 ? 76 : 110,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {heading}
            </div>
            <div
              style={{ color: "#2b2f46", fontSize: line.length > 90 ? 28 : 34, lineHeight: 1.35 }}
            >
              {line}
            </div>
          </div>
          <Sprite src={cooler} width={84} height={180} />
        </div>
      </div>
    </div>,
    OG_SIZE,
  );
};

export const siteCardAlt = `${siteConfig.name} — ${siteConfig.description}`;

/** A prose page's card: its title over its description. */
export const pageCard = (page: ProsePage): Promise<ImageResponse> =>
  ogCard({ bar: new URL(siteConfig.url).host, heading: page.title, line: page.description });

export const pageCardAlt = (page: ProsePage): string =>
  `${page.title} | ${siteConfig.name} — ${page.description}`;
