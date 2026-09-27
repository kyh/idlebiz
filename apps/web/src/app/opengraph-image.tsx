import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

import { siteConfig } from "@/lib/site-config";

export const alt = `${siteConfig.name} — ${siteConfig.description}`;
export const size = { height: 630, width: 1200 };
export const contentType = "image/png";

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

const OpengraphImage = async () => {
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
            letterSpacing: 3,
            padding: "12px 24px",
          }}
        >
          IDLEBIZ.EXE
        </div>
        <div style={{ alignItems: "flex-end", display: "flex", gap: 48, padding: "40px 56px" }}>
          <Sprite src={desk} width={156} height={288} />
          <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 24 }}>
            <div style={{ color: INK, fontSize: 110, fontWeight: 700, lineHeight: 1 }}>
              {siteConfig.name}
            </div>
            <div style={{ color: "#2b2f46", fontSize: 34, lineHeight: 1.35 }}>
              An idle business sim where your employees are real AI agents.
            </div>
          </div>
          <Sprite src={cooler} width={84} height={180} />
        </div>
      </div>
    </div>,
    size,
  );
};

export default OpengraphImage;
