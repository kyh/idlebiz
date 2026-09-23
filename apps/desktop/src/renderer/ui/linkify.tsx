import type { ReactNode } from "react";
import { bridge } from "@/renderer/bridge";
import { ASSET_TOKEN, relFromToken } from "@/renderer/ui/asset-token";

// Renders agent text with clickable assets: URLs open in the browser, and
// anything that looks like a file path opens with the OS default app (guarded
// server-side to stay inside shared/ or a product's workspace).

const openAsset = async (token: string): Promise<void> => {
  if (/^https?:\/\//u.test(token)) {
    window.open(token, "_blank");
    return;
  }
  try {
    await bridge().openCompanyPath({ rel: relFromToken(token) });
  } catch {
    // a path main refuses is dropped on purpose; the text stays as it was
  }
};

/** One line/paragraph of agent text with URLs + file paths made clickable. */
export const RichText = ({ text }: { text: string }) => {
  const parts: ReactNode[] = [];
  let last = 0;
  // matchAll, not exec: exec advances ASSET_TOKEN.lastIndex, and mutating
  // module-level state during render breaks on a re-entrant render.
  for (const m of text.matchAll(ASSET_TOKEN)) {
    const [token] = m;
    if (m.index > last) {
      parts.push(text.slice(last, m.index));
    }
    parts.push(
      <button
        type="button"
        key={`${m.index}-${token}`}
        onClick={(e) => {
          e.stopPropagation();
          void openAsset(token);
        }}
        className="cursor-pointer underline decoration-dotted underline-offset-2"
        style={{ color: "var(--accent-lo)", font: "inherit", letterSpacing: "inherit" }}
        title={/^https?:/u.test(token) ? "Open in browser" : "Open from the workspace"}
      >
        {token}
      </button>,
    );
    last = m.index + token.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
};
