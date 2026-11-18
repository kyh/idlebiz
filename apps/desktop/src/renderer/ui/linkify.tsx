import type { ReactNode } from "react";
import { api } from "@/renderer/api";
import { ASSET_TOKEN } from "@/renderer/ui/asset-token";

const openAsset = async (token: string) => {
  if (/^https?:\/\//u.test(token)) {
    window.open(token, "_blank");

    return;
  }

  await api.company.openPath({ rel: token }).catch(() => null);
};

/** One line/paragraph of agent text with URLs + file paths made clickable. */
export const RichText = ({ text }: { text: string }) => {
  const parts: ReactNode[] = [];
  let last = 0;

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
        className="text-accent-lo underline decoration-dotted underline-offset-2"
        style={{ font: "inherit", letterSpacing: "inherit" }}
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
