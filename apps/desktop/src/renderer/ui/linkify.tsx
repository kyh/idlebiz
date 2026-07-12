import type { ReactNode } from "react";

// Renders agent text with clickable assets: URLs open in the browser, and
// anything that looks like a workspace file path opens with the OS default app
// (guarded server-side to stay inside the company workspace).

// URLs · absolute paths inside the workspace · relative dir/file paths ·
// bare root files with doc-ish extensions (curated so prose like "Node.js" stays text)
const TOKEN =
  /(https?:\/\/[^\s)>\]"'`]+|(?:\/[\w.-]+)*\/workspace\/[\w./-]+|(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.\w{1,5}|\b[\w-]+\.(?:html|md|json|csv|pdf|png|txt)\b)/g;

function relFromToken(token: string): string {
  const i = token.indexOf("/workspace/");
  return i >= 0 ? token.slice(i + "/workspace/".length) : token;
}

function openAsset(companyId: string, token: string): void {
  const bridge = window.appBridge;
  if (!bridge) return;
  if (/^https?:\/\//.test(token)) {
    window.open(token, "_blank");
    return;
  }
  void bridge.openCompanyPath({ companyId, rel: relFromToken(token) }).catch(() => {});
}

/** One line/paragraph of agent text with URLs + file paths made clickable. */
export function RichText({ text, companyId }: { text: string; companyId: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text)) !== null) {
    const token = m[0];
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <button
        type="button"
        key={`${m.index}-${token}`}
        onClick={(e) => {
          e.stopPropagation();
          openAsset(companyId, token);
        }}
        className="cursor-pointer underline decoration-dotted underline-offset-2"
        style={{ color: "var(--accent-lo)", font: "inherit", letterSpacing: "inherit" }}
        title={/^https?:/.test(token) ? "Open in browser" : "Open from the workspace"}
      >
        {token}
      </button>,
    );
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
